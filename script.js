import { createClient } from "@supabase/supabase-js";
import { MAX_STUDENTS, validateInput, groupSummary, layoutSummary, resolveGroupColumns } from "./input-model.js";
import { readSavedArrangements } from "./arrangement-history.js";
import { createAccountStore, createAuthService, accountErrorMessage } from "./account-service.js";

const supabase = import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ? createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } },
) : null;
const accountStore = supabase ? createAccountStore(supabase) : null;
const authService = supabase ? createAuthService(supabase, `${window.location.origin}${window.location.pathname}`) : null;
const starterStudents = [
  { id: "2501", score: 8, vision: false }, { id: "2502", score: 4, vision: true },
  { id: "2503", score: 7, vision: false }, { id: "2504", score: 5, vision: false },
  { id: "2505", score: 9, vision: true }, { id: "2506", score: 6, vision: false },
];

const $ = (selector) => document.querySelector(selector);
const studentList = $("#studentList");
const relationList = $("#relationList");
const studentTemplate = $("#studentTemplate");
const relationTemplate = $("#relationTemplate");
const groupCount = $("#groupCount");
const groupColumns = $("#groupColumns");
const deskGrid = $("#deskGrid");
const seatingCanvas = $("#seatingCanvas");
const authDialog = $("#authDialog");
const authMessage = $("#authMessage");
let currentUser = null;
let currentClass = null;
let editingSavedData = false;
let inputRevision = 0;
let loadRequest = 0;
let hasValidated = false;
let arrangementHistory = [];
let generationJob = null;
let dataJob = null;
let lastResult = null;
let lastResultRevision = -1;
let authMode = "signin";
let authBusy = false;
let authRequest = 0;
let resendAvailableAt = 0;

function cancelGeneration() {
  if (!generationJob) return;
  generationJob.cancelled = true;
  generationJob.controller.abort();
  generationJob.worker?.terminate();
  generationJob.reject?.(new Error("계산 취소"));
  generationJob = null;
  $("#generateButton").disabled = false;
  $("#generateButton").textContent = "배치 결과 만들기 →";
  $("#processStatus").textContent = "입력이 변경되어 계산을 취소했습니다. 다시 실행해 주세요.";
}

function setStatus(message, tone = "neutral") {
  for (const element of [$("#saveStatus"), $("#savedDataStatus")]) {
    element.textContent = message;
    element.style.color = tone === "success" ? "#17855c" : tone === "error" ? "#a83e4a" : "#758296";
  }
}

function addStudent(student = { id: "", score: "", vision: false }) {
  const row = studentTemplate.content.firstElementChild.cloneNode(true);
  row.dataset.key = crypto.randomUUID();
  row.querySelector(".student-id").value = student.id;
  row.querySelector(".student-score").value = student.score;
  row.querySelector(".student-vision").checked = student.vision;
  row.querySelector(".remove-button").addEventListener("click", () => {
    if (studentList.children.length === 1) return;
    const removed = removeStudentRows([row]);
    noteInputChange();
    $("#inputSourceMessage").textContent = `학생 입력칸을 삭제했습니다.${removed ? ` 연결된 관계 ${removed}개도 제외했습니다.` : ""} 아직 DB에는 반영되지 않았습니다.`;
  });
  row.querySelectorAll("input").forEach((input) => input.addEventListener("input", () => {
    if (input.classList.contains("student-id")) refreshRelationOptions();
    noteInputChange();
  }));
  studentList.append(row);
  updateCounts();
  return row;
}

function studentRows() { return [...studentList.querySelectorAll(".student-row")]; }
function studentOptions() {
  return studentRows().map((row, index) => ({
    key: row.dataset.key,
    id: row.querySelector(".student-id").value.trim(),
    label: row.querySelector(".student-id").value.trim() || `${index + 1}번째 학생 (학번 미입력)`,
  }));
}

function refreshSelect(select, selected) {
  const students = studentOptions();
  const placeholder = document.createElement("option");
  placeholder.value = ""; placeholder.textContent = "학생 선택";
  select.replaceChildren(placeholder, ...students.map((student) => {
    const option = document.createElement("option");
    option.value = student.key;
    option.textContent = student.label;
    return option;
  }));
  select.value = students.some(student => student.key === selected) ? selected : "";
}

function refreshRelationOptions() {
  relationList.querySelectorAll(".relation-first, .relation-second").forEach((select) => refreshSelect(select, select.value));
}

function addRelation(first, type = "friend", second) {
  const row = relationTemplate.content.firstElementChild.cloneNode(true);
  const firstSelect = row.querySelector(".relation-first");
  const secondSelect = row.querySelector(".relation-second");
  refreshSelect(firstSelect, studentOptions().find(student => student.id === first)?.key);
  refreshSelect(secondSelect, studentOptions().find(student => student.id === second)?.key);
  row.querySelector(".relation-type").value = type;
  row.querySelector(".remove-button").addEventListener("click", () => {
    row.remove(); updateCounts(); noteInputChange();
  });
  row.querySelectorAll("select").forEach(select => select.addEventListener("change", noteInputChange));
  relationList.append(row);
  updateCounts();
}

function removeStudentRows(rows) {
  const keys = new Set(rows.map(row => row.dataset.key));
  let removed = 0;
  relationList.querySelectorAll(".relation-row").forEach(row => {
    if ([...row.querySelectorAll(".relation-first, .relation-second")].some(select => keys.has(select.value))) {
      row.remove(); removed++;
    }
  });
  rows.forEach(row => row.remove());
  refreshRelationOptions(); updateCounts();
  return removed;
}

function updateCounts() {
  const count = studentList.children.length;
  $("#studentCount").value = count;
  $("#studentCountStatus").textContent = `입력칸 ${count}개`;
  $("#addStudentButton").disabled = count >= MAX_STUDENTS;
  studentRows().forEach(row => { row.querySelector(".remove-button").disabled = count <= 1; });
  groupCount.max = count;
  $("#pairsButton").disabled = count < 2 || count % 2 !== 0;
  $("#pairsHelp").textContent = count % 2 !== 0
    ? "학생 수가 홀수이므로 전원을 2명씩 나눌 수 없습니다. 모둠 수를 직접 입력하거나 학생 수를 수정해 주세요."
    : "짝 배치를 선택하면 학생 수 ÷ 2를 그룹 수에 입력합니다.";
  $("#groupSummary").textContent = groupSummary(count, Number(groupCount.value));
  updateLayoutControls();
  $("#relationEmpty").hidden = relationList.children.length > 0;
}

function updateLayoutControls(clamp = false) {
  const count = Number(groupCount.value);
  const columns = groupColumns.value === "" ? NaN : Number(groupColumns.value);
  const validCount = Number.isInteger(count) && count >= 1 && count <= studentList.children.length;
  groupColumns.max = validCount ? count : MAX_STUDENTS;
  $("#squareLayoutButton").disabled = !validCount;
  // Clamp only after committing a smaller group count, not while typing it.
  if (clamp && validCount && Number.isInteger(columns) && columns > count) groupColumns.value = count;
  $("#layoutSummary").textContent = layoutSummary(count, groupColumns.value === "" ? NaN : Number(groupColumns.value));
}

function noteInputChange() {
  inputRevision++;
  cancelGeneration();
  lastResult = null;
  lastResultRevision = -1;
  $("#groupSummary").textContent = groupSummary(studentList.children.length, Number(groupCount.value));
  updateLayoutControls();
  if (deskGrid.children.length) {
    deskGrid.replaceChildren();
    seatingCanvas.style.minWidth = "";
    document.querySelectorAll(".metric strong").forEach(element => { element.textContent = "–"; });
    $("#resultDetails").textContent = "";
    $("#resultMessage").textContent = "입력이 변경되었습니다. 결과를 다시 생성해 주세요.";
    $("#processStatus").textContent = "입력이 변경되었습니다. 배치 결과를 다시 생성해 주세요.";
    document.querySelectorAll(".progress-step").forEach((step, index) => step.classList.toggle("is-active", index === 0));
  }
  if (hasValidated) showValidation(false);
  if (currentUser && !dataJob) setStatus(editingSavedData ? "변경사항 있음 · 수정 내용 저장을 눌러 주세요." : "변경사항 있음 · 내 계정에 저장을 눌러 주세요.");
}

function hasEnteredData() {
  return relationList.children.length > 0 || studentRows().some(row =>
    row.querySelector(".student-id").value || row.querySelector(".student-score").value || row.querySelector(".student-vision").checked);
}

function clearValidation() {
  document.querySelectorAll('[aria-invalid="true"]').forEach(element => element.removeAttribute("aria-invalid"));
  document.querySelectorAll(".field-error").forEach(element => { element.textContent = ""; element.hidden = true; });
  $("#validationSummary").replaceChildren();
  $("#validationSummary").hidden = true;
}

function issueTarget(issue) {
  if (issue.field.startsWith("student-")) return studentRows()[issue.index]?.querySelector(`.${issue.field}`);
  if (issue.field.startsWith("relation-")) return relationList.children[issue.index]?.querySelector(`.${issue.field}`);
  return document.getElementById(issue.field);
}

function showIssues(issues, focus = true) {
  clearValidation();
  if (!issues.length) return;
  const summary = $("#validationSummary");
  const title = document.createElement("strong");
  title.textContent = `입력 ${issues.length}곳을 확인해 주세요.`;
  const list = document.createElement("ul");
  issues.forEach(issue => {
    const target = issueTarget(issue);
    if (target) {
      target.setAttribute("aria-invalid", "true");
      const error = target.closest(".student-row, .relation-row")?.querySelector(".field-error");
      if (error) { error.hidden = false; error.textContent += `${issue.message} `; }
    }
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button"; button.textContent = issue.message;
    button.addEventListener("click", () => target?.focus());
    item.append(button); list.append(item);
  });
  summary.append(title, list); summary.hidden = false;
  if (focus) { summary.focus(); summary.scrollIntoView({ behavior: "smooth", block: "center" }); }
}

function showValidation(focus = true) {
  const issues = validateInput({ students: getStudents(), relations: getRelations(), settings: getSettings(), studentCount: Number($("#studentCount").value) });
  showIssues(issues, focus);
  return issues.length === 0;
}

function validateForAction() { hasValidated = true; return showValidation(); }

function confirmInputChange(message) {
  const dialog = $("#confirmInputDialog");
  $("#confirmInputMessage").textContent = message;
  dialog.returnValue = "";
  return new Promise(resolve => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
    dialog.showModal();
  });
}

async function applyStudentCount() {
  const count = Number($("#studentCount").value);
  if (!Number.isInteger(count) || count < 1 || count > MAX_STUDENTS) {
    showIssues([{ field: "studentCount", message: `학생 수는 1~${MAX_STUDENTS} 사이의 정수로 입력해 주세요.` }]);
    return;
  }
  const rows = studentRows();
  if (count < rows.length) {
    if (!await confirmInputChange(`마지막 학생 ${rows.length - count}명의 입력과 연결된 관계를 제외합니다. 계속할까요? DB 데이터는 아직 변경되지 않습니다.`)) {
      updateCounts(); if (hasValidated) showValidation(false); return;
    }
    removeStudentRows(rows.slice(count));
  } else {
    for (let index = rows.length; index < count; index++) addStudent();
    refreshRelationOptions();
  }
  updateCounts(); clearValidation(); noteInputChange();
}

async function resetInput(useExample = false, ask = true) {
  if (ask && hasEnteredData() && !await confirmInputChange("현재 입력을 바꿀까요? 저장하지 않은 입력은 사라집니다. DB의 저장 데이터는 변경하지 않습니다.")) return false;
  editingSavedData = false;
  updateDataButtons();
  hasValidated = false; clearValidation();
  arrangementHistory = [];
  studentList.replaceChildren(); relationList.replaceChildren();
  if (useExample) {
    starterStudents.forEach(addStudent);
    addRelation("2501", "friend", "2503"); addRelation("2502", "rival", "2505");
  } else addStudent();
  applySettings({ groupCount: useExample ? 3 : 1, scoreMode: "balanced", friendMode: "together", respectVision: true, avoidPrevious: false });
  $("input[name=inputSource][value=new]").checked = true;
  updateSourceChoice(); updateCounts(); noteInputChange();
  $("#inputSourceMessage").textContent = useExample ? "시연용 예시 6명입니다. 실제 학생 데이터가 아니며 아직 DB에 저장되지 않았습니다." : "새 입력을 시작합니다. DB의 저장 데이터는 변경되지 않았습니다.";
  return true;
}

function updateSourceChoice() {
  const saved = $("input[name=inputSource]:checked").value === "saved";
  $("#loadDataButton").hidden = !saved;
  $("#inputSourceMessage").textContent = saved
    ? "로그인 후 ‘저장 데이터 불러오기’를 누르면 학생·관계·설정값을 불러와 수정할 수 있습니다. 수정한 내용은 ‘수정 내용 저장’을 눌러 반영합니다."
    : "학번과 성적을 직접 입력합니다. 기존 내용을 지우려면 ‘입력 내용 비우기’를 선택해 주세요.";
}

function applySettings(settings) {
  groupCount.value = settings.groupCount;
  groupColumns.value = resolveGroupColumns(settings.groupCount, settings.groupColumns);
  document.querySelectorAll("input[name=scoreMode]").forEach(input => { input.checked = input.value === settings.scoreMode; });
  document.querySelectorAll("input[name=friendMode]").forEach(input => { input.checked = input.value === settings.friendMode; });
  $("#visionToggle").checked = settings.respectVision;
  $("#duplicateToggle").checked = settings.avoidPrevious;
}

function getStudents() {
  return [...studentList.querySelectorAll(".student-row")].map((row, index) => ({
    id: row.querySelector(".student-id").value.trim(),
    score: row.querySelector(".student-score").value === "" ? NaN : Number(row.querySelector(".student-score").value),
    vision: row.querySelector(".student-vision").checked,
    order: index,
  }));
}

function getRelations() {
  const students = new Map(studentOptions().map(student => [student.key, student.id]));
  return [...relationList.querySelectorAll(".relation-row")]
    .map((row) => ({
      first: students.get(row.querySelector(".relation-first").value) ?? "",
      second: students.get(row.querySelector(".relation-second").value) ?? "",
      type: row.querySelector(".relation-type").value,
    }));
}

function getSettings() {
  return {
    groupCount: groupCount.value === "" ? NaN : Number(groupCount.value),
    groupColumns: groupColumns.value === "" ? NaN : Number(groupColumns.value),
    scoreMode: $("input[name=scoreMode]:checked")?.value,
    friendMode: $("input[name=friendMode]:checked")?.value,
    respectVision: $("#visionToggle").checked,
    avoidPrevious: $("#duplicateToggle").checked,
  };
}

function renderResult(result, settings, historyNote) {
  deskGrid.replaceChildren();
  deskGrid.style.setProperty("--group-columns", result.layout.groupColumns);
  const individual = settings.groupCount === result.seated.length;
  seatingCanvas.style.minWidth = `${Math.max(180, result.layout.groupColumns * (individual ? 92 : 160) + (result.layout.groupColumns - 1) * 14)}px`;
  deskGrid.setAttribute("aria-label", layoutSummary(settings.groupCount, result.layout.groupColumns));
  result.layout.groups.forEach((group, index) => {
    const block = document.createElement("section");
    block.className = "group-block";
    block.setAttribute("aria-label", `${group.groupNumber}그룹`);
    const title = document.createElement("h3");
    title.textContent = individual ? `${group.groupNumber}번 자리` : `${group.groupNumber}그룹`;
    const description = document.createElement("p");
    description.textContent = `${group.members.length}명 · 평균 성적 ${result.details.means[index].toFixed(1)}`;
    const seats = document.createElement("div");
    seats.className = "group-seats";
    seats.style.setProperty("--seat-columns", result.layout.seatColumns);
    for (let slot = 0; slot < result.layout.blockRows * result.layout.seatColumns; slot++) {
      const student = group.members[slot];
      const desk = document.createElement("div");
      if (!student) { desk.className = "empty-desk"; desk.setAttribute("aria-hidden", "true"); }
      else {
        desk.className = `desk${settings.respectVision && student.vision ? " vision" : ""}`;
        desk.textContent = student.id;
        if (settings.respectVision && student.vision) {
          const label = document.createElement("small"); label.textContent = "시력 고려"; desk.append(label);
        }
      }
      seats.append(desk);
    }
    block.append(title, description, seats); deskGrid.append(block);
  });
  $("#balanceMetric").textContent = `${result.metrics.balance}%`;
  $("#scoreMetric").textContent = result.metrics.score === null ? "미반영" : `${result.metrics.score}%`;
  $("#friendMetric").textContent = settings.friendMode === "ignore" ? "미반영" : result.metrics.friend === null ? "관계 없음" : `${result.metrics.friend}%`;
  $("#rivalMetric").textContent = result.metrics.rival === null ? "관계 없음" : `${result.metrics.rival}%`;
  $("#visionMetric").textContent = !settings.respectVision ? "미반영" : result.metrics.vision === null ? "대상 없음" : `${result.metrics.vision}%`;
  $("#previousMetric").textContent = !settings.avoidPrevious ? "미반영" : !result.details.totalPairs ? "비교 조합 없음" : result.metrics.previous === null ? "기록 없음" : `${result.metrics.previous}%`;
  const scoreNote = settings.scoreMode === "balanced" ? `그룹 평균 성적 차이 ${result.details.meanGap.toFixed(2)}`
    : settings.scoreMode === "similar" ? `그룹 안 성적 편차 ${result.details.withinDeviation.toFixed(2)}` : "성적 미반영";
  $("#resultDetails").textContent = `${scoreNote}. ${settings.respectVision ? `시력 고려 ${result.details.visionTotal}명 중 ${result.details.visionFront}명이 맨 앞줄.` : ""} ${historyNote}`;
  $("#resultMessage").textContent = `${result.seated.length}명 · ${settings.groupCount}개 ${individual ? "개인 자리" : "그룹"} · 가로 ${result.layout.groupColumns}열 × 세로 ${Math.ceil(settings.groupCount / result.layout.groupColumns)}줄${individual ? "" : " (그룹 기준)"}`;
  document.querySelectorAll(".progress-step").forEach((step) => step.classList.add("is-active"));
}

function requireLogin(message = "데이터를 저장하려면 먼저 로그인해 주세요.") {
  if (currentUser) return true;
  setAuthMode("signin");
  showAuthMessage(supabase ? message : "DB 연결 설정이 없습니다. .env.local의 Supabase 주소와 공개 키를 확인해 주세요.", supabase ? "neutral" : "error");
  if (!authDialog.open) authDialog.showModal();
  return false;
}

function updateDataButtons() {
  $("#saveButton").disabled = Boolean(dataJob);
  $("#loadDataButton").disabled = Boolean(dataJob);
  $("#saveButton").textContent = dataJob?.type === "save" ? "내 계정에 저장 중…" : "내 계정에 저장";
  $("#savedDataEditor").hidden = !editingSavedData;
  $("#saveEditedDataButton").disabled = Boolean(dataJob);
  $("#saveEditedDataButton").textContent = dataJob?.type === "save" ? "수정 내용 저장 중…" : "수정 내용 저장";
}

async function saveClassData() {
  if (dataJob) return false;
  if (!requireLogin()) return false;
  if (!validateForAction()) return false;
  const input = { students: getStudents(), relations: getRelations(), settings: getSettings() };
  const revision = inputRevision;
  const result = lastResultRevision === revision ? lastResult : null;
  const job = { type: "save", userId: currentUser.id };
  dataJob = job; updateDataButtons();
  const stillCurrent = () => dataJob === job && currentUser?.id === job.userId;
  try {
    setStatus("저장 중…");
    let expectedRevision = currentClass?.revision ?? null;
    if (!currentClass) {
      const existing = await accountStore.load();
      if (!stillCurrent()) return false;
      if (existing) {
        if (!await confirmInputChange("이 계정에 저장된 학생 데이터가 있습니다. 현재 화면의 학생·관계·설정으로 덮어쓸까요? 기존 배치 이력은 유지됩니다.")) { setStatus("저장을 취소했습니다. 기존 DB 데이터는 유지됩니다."); return false; }
        if (!stillCurrent()) return false;
        expectedRevision = existing.classroom.revision;
      }
    }
    if (revision !== inputRevision) { setStatus("저장 확인 중 입력이 바뀌었습니다. 현재 입력으로 다시 저장해 주세요."); return false; }
    const saved = await accountStore.save(input, { expectedRevision, result });
    if (!stillCurrent()) return false;
    currentClass = saved.classroom;
    editingSavedData = true;
    $("#className").textContent = currentClass.name;
    setStatus(revision === inputRevision
      ? `${input.students.length}명·관계·설정${result ? "·배치 결과" : ""} 저장 완료`
      : "이전 입력은 저장됨 · 저장 중 수정한 내용은 아직 미저장", "success");
    return true;
  } catch (error) {
    if (stillCurrent() && error.code !== "SESSION_CHANGED") setStatus(`저장 실패: ${accountErrorMessage(error)}`, "error");
    return false;
  } finally {
    if (dataJob === job) { dataJob = null; updateDataButtons(); }
  }
}

async function generate() {
  if (generationJob) return;
  if (!validateForAction()) return;
  lastResult = null; lastResultRevision = -1;
  const input = { students: getStudents(), relations: getRelations(), settings: getSettings() };
  const revision = inputRevision;
  const userId = currentUser?.id;
  const job = { controller: new AbortController(), cancelled: false, worker: null, reject: null };
  generationJob = job;
  $("#generateButton").disabled = true;
  $("#generateButton").textContent = "배치 계산 중…";
  $("#processStatus").textContent = "필수 조건을 확인하고 배치 후보를 비교하고 있습니다.";
  let history = [...arrangementHistory];
  let historyNote = input.settings.avoidPrevious ? "이번 방문에서 생성한 이전 배치와 비교했습니다." : "";
  try {
    if (input.settings.avoidPrevious && currentUser && supabase) {
      const timeout = setTimeout(() => job.controller.abort(), 5000);
      try {
        const saved = await readSavedArrangements(supabase, userId, currentClass?.id, job.controller.signal);
        history = [...saved, ...history];
        historyNote = "저장된 최근 배치와 이번 방문의 이전 배치를 비교했습니다.";
      } catch {
        historyNote = "저장된 이전 배치를 불러오지 못해 이번 방문의 기록만 비교했습니다.";
      } finally { clearTimeout(timeout); }
    }
    if (job.cancelled || revision !== inputRevision) return;
    const result = await new Promise((resolve, reject) => {
      job.reject = reject;
      const worker = new Worker(new URL("./arrangement-worker.js", import.meta.url), { type: "module" });
      job.worker = worker;
      worker.onmessage = event => { worker.terminate(); job.worker = null; event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.result); };
      worker.onerror = () => { worker.terminate(); job.worker = null; reject(new Error("배치 계산을 실행하지 못했습니다. 다시 실행해 주세요.")); };
      worker.postMessage({ input, options: { previousArrangements: history } });
    });
    if (job.cancelled || revision !== inputRevision) return;
    if (result.status !== "success") {
      deskGrid.replaceChildren();
      document.querySelectorAll(".metric strong").forEach(element => { element.textContent = "–"; });
      $("#resultDetails").textContent = "";
      $("#resultMessage").textContent = "배치를 생성하지 못했습니다.";
      $("#processStatus").textContent = result.status === "infeasible"
        ? "현재 그룹 수와 앙숙 관계로는 인원 균형을 지키는 배치가 불가능합니다. 그룹 수 또는 관계 입력을 확인해 주세요."
        : "계산 시간 안에 필수 조건을 만족하는 배치를 찾지 못했습니다. 다시 계산하거나 그룹 수를 조정해 주세요.";
      return;
    }
    if (input.settings.avoidPrevious && !result.details.historyCount && !history.length) historyNote = "비교할 이전 배치가 없어 이번 결과부터 기록합니다.";
    renderResult(result, input.settings, historyNote);
    lastResult = result; lastResultRevision = revision;
    arrangementHistory = [...arrangementHistory, result.layout.groups.map(group => group.members.map(student => student.id))].slice(-20);
    $("#processStatus").textContent = "배치 계산을 완료했습니다.";
    $("#resultSection").scrollIntoView({ behavior: "smooth", block: "start" });
    if (currentUser && !dataJob) setStatus("배치 생성 완료 · 내 계정에 저장을 누르면 DB에 반영됩니다.");
  } catch (error) {
    if (!job.cancelled) $("#processStatus").textContent = error.message;
  } finally {
    job.worker?.terminate();
    if (generationJob === job) {
      generationJob = null;
      $("#generateButton").disabled = false;
      $("#generateButton").textContent = "다시 배치하기 →";
    }
  }
}

async function loadClassData() {
  const userId = currentUser.id;
  const revision = inputRevision;
  const request = ++loadRequest;
  const saved = await accountStore.load();
  if (currentUser?.id !== userId || loadRequest !== request) return;
  if (inputRevision !== revision) { $("#inputSourceMessage").textContent = "불러오는 동안 입력이 변경되어 적용을 취소했습니다. 현재 입력은 유지됩니다."; return; }
  if (!saved || !saved.students.length) { $("#inputSourceMessage").textContent = "이 계정에 저장된 학생이 없습니다. 현재 입력은 유지됩니다."; return; }
  if (validateInput(saved).length) throw new Error("CLASSROOM_INVALID_INPUT");
  // Replace the current form only after every read has succeeded.
  if (currentClass?.id !== saved.classroom.id) arrangementHistory = [];
  currentClass = saved.classroom;
  editingSavedData = true;
  studentList.replaceChildren(); relationList.replaceChildren();
  saved.students.forEach(addStudent);
  saved.relations.forEach(relation => addRelation(relation.first, relation.type, relation.second));
  applySettings(saved.settings);
  $("#className").textContent = currentClass.name;
  $("input[name=inputSource][value=saved]").checked = true;
  updateSourceChoice(); updateDataButtons();
  updateCounts(); hasValidated = false; clearValidation(); noteInputChange();
  $("#inputSourceMessage").textContent = `${saved.students.length}명의 저장된 학생·관계·설정을 불러왔습니다. 아래 입력란에서 수정한 뒤 ‘수정 내용 저장’을 눌러 주세요.`;
  setStatus("저장 데이터를 불러왔습니다. 아래 입력란에서 수정할 수 있습니다.", "success");
  $(".student-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  studentRows()[0]?.querySelector(".student-id").focus({ preventScroll: true });
}

async function requestSavedData() {
  if (dataJob) return;
  if (!requireLogin("저장된 학생 데이터를 불러오려면 먼저 로그인해 주세요.")) return;
  const userId = currentUser.id;
  if (hasEnteredData() && !await confirmInputChange("현재 입력을 저장된 학생·관계·설정값으로 바꿀까요? 저장하지 않은 입력은 사라집니다.")) return;
  if (currentUser?.id !== userId) return;
  const job = { type: "load", userId };
  dataJob = job; updateDataButtons();
  $("#inputSourceMessage").textContent = "저장 데이터를 불러오는 중입니다…";
  try { await loadClassData(); }
  catch (error) { if (dataJob === job && error.code !== "SESSION_CHANGED") $("#inputSourceMessage").textContent = `불러오기 실패: ${accountErrorMessage(error)} 현재 입력은 유지됩니다.`; }
  finally { if (dataJob === job) { dataJob = null; updateDataButtons(); } }
}

function setSession(session) {
  const previousUser = currentUser?.id;
  currentUser = session?.user ?? null;
  accountStore?.setUser(currentUser);
  $("#authButton").textContent = currentUser ? "로그아웃" : "회원가입·로그인";
  $("#accountIdentity").textContent = currentUser?.email ?? "";
  $("#accountIdentity").title = currentUser?.email ?? "";
  if (previousUser !== currentUser?.id) {
    cancelGeneration(); arrangementHistory = []; currentClass = null; editingSavedData = false; dataJob = null; loadRequest++; updateDataButtons();
    // Do not make another Supabase call synchronously inside its auth callback.
    setTimeout(checkBackend, 0);
  }
  if (previousUser && previousUser !== currentUser?.id) resetInput(false, false);
  if (previousUser && !currentUser) { $("#emailInput").value = ""; $("#resendEmailButton").hidden = true; }
  if (previousUser !== currentUser?.id) $("#className").textContent = "2학년 5반";
  if (currentUser && authDialog.open) authDialog.close();
  setStatus(currentUser ? "로그인됨 · 저장 데이터를 선택해서 불러올 수 있습니다." : "로그인하면 DB에 저장할 수 있습니다.");
}

function showAuthMessage(message, tone = "neutral") {
  authMessage.textContent = message;
  authMessage.dataset.tone = tone;
}

function updateAuthControls() {
  $("#signInModeButton").disabled = authBusy;
  $("#signUpButton").disabled = authBusy;
  $("#emailInput").disabled = authBusy;
  $("#passwordInput").disabled = authBusy;
  $("#passwordConfirmInput").disabled = authBusy || authMode !== "signup";
  $("#authSubmitButton").disabled = authBusy || !authService;
  $("#authSubmitButton").textContent = authBusy ? "요청 중…" : authMode === "signup" ? "회원가입 →" : "로그인 →";
  $("#resendEmailButton").disabled = authBusy || !authService || Date.now() < resendAvailableAt;
}

function setAuthMode(mode) {
  if (authBusy) return;
  authMode = mode;
  const signup = mode === "signup";
  $("#authTitle").textContent = signup ? "새 계정 만들기" : "계정으로 로그인";
  $("#signInModeButton").setAttribute("aria-pressed", String(!signup));
  $("#signUpButton").setAttribute("aria-pressed", String(signup));
  $("#passwordConfirmLabel").hidden = !signup;
  $("#passwordConfirmInput").required = signup;
  $("#passwordConfirmInput").value = "";
  $("#passwordInput").minLength = signup ? 8 : 1;
  $("#passwordInput").autocomplete = signup ? "new-password" : "current-password";
  $("#passwordHelp").textContent = signup ? "8자 이상의 비밀번호를 입력합니다. 이메일 인증 후 로그인할 수 있습니다. 비밀번호는 Supabase Auth에서 관리합니다." : "비밀번호는 이 사이트의 학생 DB에 저장하지 않으며 Supabase Auth에서 관리합니다.";
  showAuthMessage(""); updateAuthControls();
}

async function withAuthTimeout(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "REQUEST_TIMEOUT" })), 15000); })]); }
  finally { clearTimeout(timer); }
}

async function submitAuth(event) {
  event.preventDefault();
  if (authBusy || !authService || !$("#authForm").reportValidity()) return;
  const request = ++authRequest;
  const values = { email: $("#emailInput").value, password: $("#passwordInput").value, confirmation: $("#passwordConfirmInput").value };
  authBusy = true; updateAuthControls(); showAuthMessage(authMode === "signup" ? "계정을 만드는 중입니다…" : "로그인 중입니다…");
  try {
    const data = await withAuthTimeout(authService.submit(values, authMode));
    if (request !== authRequest) return;
    if (data.session) { setSession(data.session); if (authDialog.open) authDialog.close(); }
    else {
      showAuthMessage("인증 메일을 확인해 주세요. 이미 가입한 이메일이라면 로그인해 주세요. 메일 인증을 마친 뒤 로그인할 수 있습니다.");
      $("#resendEmailButton").hidden = false;
      $("#passwordInput").value = ""; $("#passwordConfirmInput").value = "";
    }
  } catch (error) {
    if (request === authRequest) {
      showAuthMessage(error.code === "INVALID_CREDENTIALS_INPUT" ? error.message : accountErrorMessage(error), "error");
      if (error.code === "email_not_confirmed") $("#resendEmailButton").hidden = false;
    }
  } finally { if (request === authRequest) { authBusy = false; updateAuthControls(); } }
}

async function resendEmail() {
  if (authBusy || !authService || Date.now() < resendAvailableAt) return;
  authBusy = true; updateAuthControls();
  try {
    await withAuthTimeout(authService.resend($("#emailInput").value));
    resendAvailableAt = Date.now() + 60000;
    showAuthMessage("인증 메일 재발송을 요청했습니다. 받은편지함과 스팸함을 확인해 주세요. 다시 요청하려면 1분 후 시도해 주세요.");
    setTimeout(updateAuthControls, 60000);
  } catch (error) { showAuthMessage(error.code === "INVALID_CREDENTIALS_INPUT" ? error.message : accountErrorMessage(error), "error"); }
  finally { authBusy = false; updateAuthControls(); }
}

async function checkBackend() {
  const notice = $("#connectionNotice");
  if (!accountStore) { notice.hidden = false; notice.textContent = "DB 연결 설정이 없습니다. .env.local에 Supabase 주소와 공개 키를 설정해 주세요. 자리 배치 계산은 계속 사용할 수 있습니다."; return; }
  try {
    const status = await accountStore.status();
    if (status?.schema_version !== 3) throw Object.assign(new Error("schema"), { code: "PGRST202" });
    notice.hidden = true;
  } catch (error) {
    if (error.code === "SESSION_CHANGED") return;
    notice.hidden = false;
    notice.textContent = `${accountErrorMessage(error)} DB 연결 전에도 입력과 배치 계산은 사용할 수 있습니다.`;
  }
}

resetInput(false, false);
$("#addStudentButton").addEventListener("click", () => { if (studentList.children.length < MAX_STUDENTS) { addStudent(); refreshRelationOptions(); noteInputChange(); } });
$("#addRelationButton").addEventListener("click", () => { addRelation(); noteInputChange(); });
$("#applyStudentCountButton").addEventListener("click", applyStudentCount);
$("#studentCount").addEventListener("input", noteInputChange);
$("#studentCount").addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); applyStudentCount(); } });
$("#individualButton").addEventListener("click", () => { groupCount.value = studentList.children.length; updateLayoutControls(true); noteInputChange(); });
$("#pairsButton").addEventListener("click", () => { groupCount.value = studentList.children.length / 2; updateLayoutControls(true); noteInputChange(); });
$("#squareLayoutButton").addEventListener("click", () => {
  const count = Number(groupCount.value);
  if (!Number.isInteger(count) || count < 1 || count > studentList.children.length) return;
  groupColumns.value = Math.ceil(Math.sqrt(count));
  noteInputChange();
});
$("#clearInputButton").addEventListener("click", () => resetInput());
$("#exampleButton").addEventListener("click", () => resetInput(true));
$("#loadDataButton").addEventListener("click", requestSavedData);
document.querySelectorAll("input[name=inputSource]").forEach(input => input.addEventListener("change", () => { updateSourceChoice(); inputRevision++; }));
document.querySelectorAll("input[name=scoreMode], input[name=friendMode], #visionToggle, #duplicateToggle").forEach(input => input.addEventListener("change", noteInputChange));
groupCount.addEventListener("input", noteInputChange);
groupCount.addEventListener("change", () => { updateLayoutControls(true); noteInputChange(); });
groupColumns.addEventListener("input", noteInputChange);
$("#saveButton").addEventListener("click", () => saveClassData());
$("#saveEditedDataButton").addEventListener("click", () => saveClassData());
$("#generateButton").addEventListener("click", generate);
$("#authForm").addEventListener("submit", submitAuth);
$("#signUpButton").addEventListener("click", () => setAuthMode("signup"));
$("#signInModeButton").addEventListener("click", () => setAuthMode("signin"));
$("#resendEmailButton").addEventListener("click", resendEmail);
authDialog.addEventListener("close", () => {
  authRequest++; authBusy = false;
  $("#passwordInput").value = ""; $("#passwordConfirmInput").value = "";
  updateAuthControls();
});
$("#authButton").addEventListener("click", async () => {
  if (!currentUser) { requireLogin(); return; }
  if (hasEnteredData() && !await confirmInputChange("로그아웃하면 현재 화면의 학생 입력이 지워집니다. DB에 저장하지 않은 변경사항은 사라집니다. 로그아웃할까요?")) return;
  $("#authButton").disabled = true;
  try { await withAuthTimeout(authService.signOut()); setSession(null); }
  catch (error) { setStatus(`로그아웃 실패: ${accountErrorMessage(error)}`, "error"); }
  finally { $("#authButton").disabled = false; }
});
$("#resetButton").addEventListener("click", () => resetInput());
document.querySelectorAll(".stepper-button").forEach((button) => button.addEventListener("click", () => {
  const value = Number(groupCount.value);
  groupCount.value = Math.max(1, Math.min(studentList.children.length, (Number.isInteger(value) ? value : 1) + Number(button.dataset.step)));
  updateLayoutControls(true);
  noteInputChange();
}));

if (supabase) {
  let authEvents = 0;
  supabase.auth.onAuthStateChange((_event, nextSession) => { authEvents++; setSession(nextSession); });
  const bootEvents = authEvents;
  withAuthTimeout(supabase.auth.getSession()).then(({ data, error }) => {
    if (error) throw error;
    if (authEvents === bootEvents) setSession(data.session);
  }).catch(error => { if (authEvents === bootEvents) setStatus(`로그인 확인 실패: ${accountErrorMessage(error)}`, "error"); });
} else setStatus("DB 설정 전 · 입력과 미리보기만 사용 가능");
setAuthMode("signin");
checkBackend();
