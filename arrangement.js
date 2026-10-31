import { validateInput, resolveGroupColumns } from './input-model.js';

const EPSILON = 1e-9;
const percent = value => Math.round(100 * Math.max(0, Math.min(1, value)));
const pairKey = (a, b) => JSON.stringify([a, b].sort());
const now = () => performance.now();

export function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function shuffle(values, random) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function arrangementSignature(groups) {
  return JSON.stringify(groups.map(group => group.map(student => typeof student === 'string' ? student : student.id).sort())
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}

function prepare(input, previousArrangements) {
  const { students, relations, settings } = input;
  const indices = new Map(students.map((student, index) => [student.id, index]));
  const rivals = students.map(() => new Set());
  const friends = [];
  for (const relation of relations) {
    const a = indices.get(relation.first), b = indices.get(relation.second);
    if (relation.type === 'rival') { rivals[a].add(b); rivals[b].add(a); }
    else friends.push([a, b]);
  }
  const seenRuns = new Set();
  const previousPairs = new Set();
  let historyCount = 0;
  for (const groups of previousArrangements) {
    const filtered = groups.map(group => group.map(student => typeof student === 'string' ? student : student.id)
      .filter(id => indices.has(id))).filter(group => group.length);
    if (!filtered.some(group => group.length > 1)) continue;
    const signature = arrangementSignature(filtered);
    if (seenRuns.has(signature)) continue;
    seenRuns.add(signature); historyCount++;
    for (const group of filtered) {
      for (let a = 0; a < group.length; a++) {
        for (let b = a + 1; b < group.length; b++) previousPairs.add(pairKey(group[a], group[b]));
      }
    }
  }
  const previousMatrix = new Uint8Array(students.length * students.length);
  for (let a = 0; a < students.length; a++) for (let b = a + 1; b < students.length; b++) {
    if (previousPairs.has(pairKey(students[a].id, students[b].id))) {
      previousMatrix[a * students.length + b] = previousMatrix[b * students.length + a] = 1;
    }
  }
  const count = settings.groupCount;
  const capacities = Array.from({ length: count }, (_, index) =>
    Math.floor(students.length / count) + Number(index < students.length % count));
  return { students, settings, rivals, friends, capacities, previousMatrix, historyCount };
}

// The selected columns control both group positions and front-row capacity.
// Each group block has up to two desks across, without splitting its members.
export function createLayout(groups, respectVision, random = () => 0.5, columns) {
  const seatColumns = groups.every(group => group.length === 1) ? 1 : 2;
  const groupColumns = resolveGroupColumns(groups.length, columns);
  const blockRows = Math.max(...groups.map(group => Math.ceil(group.length / seatColumns)));
  const ordered = shuffle(groups, random).map(group => {
    const members = shuffle(group, random);
    if (respectVision) members.sort((a, b) => Number(Boolean(b.vision)) - Number(Boolean(a.vision)));
    return members;
  });
  if (respectVision) ordered.sort((a, b) =>
    Math.min(b.filter(student => student.vision).length, seatColumns) - Math.min(a.filter(student => student.vision).length, seatColumns)
    || b.filter(student => student.vision).length - a.filter(student => student.vision).length);
  return {
    groupColumns, seatColumns, blockRows,
    groups: ordered.map((members, groupIndex) => ({
      groupNumber: groupIndex + 1,
      members: members.map((student, slot) => ({
        ...student, groupNumber: groupIndex + 1,
        row: Math.floor(groupIndex / groupColumns) * blockRows + Math.floor(slot / seatColumns),
        column: groupIndex % groupColumns * seatColumns + slot % seatColumns,
      })),
    })),
  };
}

function evaluate(groups, context) {
  const { students, settings, friends, rivals, previousMatrix, historyCount } = context;
  const groupOf = new Int16Array(students.length).fill(-1);
  const means = [], visionCounts = [];
  let withinVariance = 0, repeatedPairs = 0, totalPairs = 0;
  groups.forEach((group, index) => {
    const sum = group.reduce((value, student) => value + students[student].score, 0);
    const mean = sum / group.length;
    means.push(mean);
    visionCounts.push(group.filter(student => students[student].vision).length);
    group.forEach(student => { groupOf[student] = index; withinVariance += (students[student].score - mean) ** 2; });
    totalPairs += group.length * (group.length - 1) / 2;
    if (historyCount) for (let a = 0; a < group.length; a++) {
      for (let b = a + 1; b < group.length; b++) {
        repeatedPairs += previousMatrix[group[a] * students.length + group[b]];
      }
    }
  });
  const averageMean = means.reduce((sum, mean) => sum + mean, 0) / means.length;
  const meanVariance = means.reduce((sum, mean) => sum + (mean - averageMean) ** 2, 0) / means.length;
  const scoreValue = settings.scoreMode === 'ignore' ? null : Math.max(0, 1 -
    (settings.scoreMode === 'balanced' ? meanVariance : withinVariance / students.length) / 20.25);
  const friendsMet = friends.filter(([a, b]) => settings.friendMode === 'together' ? groupOf[a] === groupOf[b] : groupOf[a] !== groupOf[b]).length;
  const friendValue = settings.friendMode === 'ignore' || !friends.length ? null : friendsMet / friends.length;
  const rivalTotal = rivals.reduce((sum, neighbors) => sum + neighbors.size, 0) / 2;
  const rivalsMet = rivals.reduce((sum, neighbors, a) => sum + [...neighbors].filter(b => a < b && groupOf[a] !== groupOf[b]).length, 0);
  const seatColumns = groups.every(group => group.length === 1) ? 1 : 2;
  const groupColumns = resolveGroupColumns(groups.length, settings.groupColumns);
  const blockRows = Math.max(...groups.map(group => Math.ceil(group.length / seatColumns)));
  const orderedVision = [...visionCounts].sort((a, b) => Math.min(b, seatColumns) - Math.min(a, seatColumns) || b - a);
  const visionTotal = visionCounts.reduce((sum, count) => sum + count, 0);
  const visionFront = orderedVision.slice(0, groupColumns).reduce((sum, count) => sum + Math.min(count, seatColumns), 0);
  const maxRow = Math.max(1, Math.ceil(groups.length / groupColumns) * blockRows - 1);
  let visionDistance = 0;
  orderedVision.forEach((count, index) => {
    for (let slot = 0; slot < count; slot++) visionDistance += Math.floor(index / groupColumns) * blockRows + Math.floor(slot / seatColumns);
  });
  const visionValue = !settings.respectVision || !visionTotal ? null :
    0.75 * visionFront / visionTotal + 0.25 * (1 - visionDistance / (visionTotal * maxRow));
  const historyValue = !settings.avoidPrevious || !historyCount || !totalPairs ? null : 1 - repeatedPairs / totalPairs;
  const values = [scoreValue, friendValue, visionValue, historyValue].filter(value => value !== null);
  const objective = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 1;
  return {
    objective,
    metrics: {
      balance: Math.max(...groups.map(group => group.length)) - Math.min(...groups.map(group => group.length)) <= 1 ? 100 : 0,
      score: scoreValue === null ? null : percent(scoreValue),
      friend: friendValue === null ? null : percent(friendValue),
      rival: rivalTotal ? percent(rivalsMet / rivalTotal) : null,
      relation: rivalTotal + (friendValue === null ? 0 : friends.length) ? percent((rivalsMet + (friendValue === null ? 0 : friendsMet)) / (rivalTotal + (friendValue === null ? 0 : friends.length))) : null,
      vision: !settings.respectVision || !visionTotal ? null : percent(visionFront / visionTotal),
      previous: historyValue === null ? null : percent(historyValue),
    },
    details: { means, meanGap: Math.max(...means) - Math.min(...means), withinDeviation: Math.sqrt(withinVariance / students.length), friendsMet, friendTotal: friends.length, rivalsMet, rivalTotal, visionFront, visionTotal, repeatedPairs, totalPairs, historyCount },
  };
}

function findFeasible(context, random, budget, visit, allSolutions) {
  const { students, rivals, capacities } = context;
  const groups = capacities.map(() => []);
  const assignment = new Int16Array(students.length).fill(-1);
  const priorities = students.map(() => random());
  let limited = false, found = false;
  const canPlace = (student, group) => groups[group].length < capacities[group] && ![...rivals[student]].some(other => assignment[other] === group);
  function search(remaining) {
    if (!budget.take()) { limited = true; return true; }
    if (!remaining) { found = true; visit(groups.map(group => [...group])); return !allSolutions; }
    let selected = -1, options = [], bestOptionCount = Infinity, bestDegree = -1;
    // Most constrained student first; ties favor students with more rivals.
    for (let student = 0; student < students.length; student++) {
      if (assignment[student] !== -1) continue;
      const allowed = capacities.map((_, group) => group).filter(group => canPlace(student, group));
      if (!allowed.length) return false;
      if (allowed.length < bestOptionCount || allowed.length === bestOptionCount &&
          (rivals[student].size > bestDegree || rivals[student].size === bestDegree && priorities[student] > priorities[selected])) {
        selected = student; options = allowed; bestOptionCount = allowed.length; bestDegree = rivals[student].size;
      }
    }
    const emptyCapacities = new Set();
    for (const group of shuffle(options, random)) {
      // Empty groups of the same capacity are interchangeable.
      if (!groups[group].length && emptyCapacities.has(capacities[group])) continue;
      if (!groups[group].length) emptyCapacities.add(capacities[group]);
      assignment[selected] = group; groups[group].push(selected);
      const stop = search(remaining - 1);
      groups[group].pop(); assignment[selected] = -1;
      if (stop) return true;
    }
    return false;
  }
  search(students.length);
  return { found, exhausted: !limited && (allSolutions || !found), limited };
}

function improve(initial, context, random, iterations, budget, consider) {
  const groups = initial.map(group => [...group]);
  let current = evaluate(groups, context).objective;
  const assignment = new Int16Array(context.students.length);
  groups.forEach((group, index) => group.forEach(student => { assignment[student] = index; }));
  for (let step = 0; step < iterations && budget.take(); step++) {
    const a = Math.floor(random() * context.students.length), b = Math.floor(random() * context.students.length);
    const ga = assignment[a], gb = assignment[b];
    if (ga === gb || [...context.rivals[a]].some(other => other !== b && assignment[other] === gb)
      || [...context.rivals[b]].some(other => other !== a && assignment[other] === ga)) continue;
    const ia = groups[ga].indexOf(a), ib = groups[gb].indexOf(b);
    [groups[ga][ia], groups[gb][ib]] = [b, a];
    const evaluated = evaluate(groups, context);
    consider(groups, evaluated);
    const temperature = 0.025 * (1 - step / iterations) + 0.0001;
    if (evaluated.objective >= current || random() < Math.exp((evaluated.objective - current) / temperature)) {
      current = evaluated.objective; assignment[a] = gb; assignment[b] = ga;
    } else [groups[ga][ia], groups[gb][ib]] = [a, b];
  }
}

export function solveArrangement(input, options = {}) {
  const issues = validateInput(input);
  if (issues.length) return { status: 'invalid', issues };
  const start = now();
  const seed = options.seed ?? Math.floor(Math.random() * 4294967296);
  const random = createRandom(seed);
  const context = prepare(input, options.previousArrangements ?? []);
  const maxOperations = options.maxOperations ?? 160000;
  const deadline = start + (options.maxTimeMs ?? 1800);
  let operations = 0, candidates = 0, ties = 0, best = null;
  const budget = { take() { return ++operations <= maxOperations && now() <= deadline; } };
  const consider = (groups, evaluated = evaluate(groups, context)) => {
    candidates++;
    if (!best || evaluated.objective > best.evaluated.objective + EPSILON) {
      best = { groups: groups.map(group => [...group]), evaluated }; ties = 1;
    } else if (Math.abs(evaluated.objective - best.evaluated.objective) < EPSILON && random() < 1 / ++ties) {
      best = { groups: groups.map(group => [...group]), evaluated };
    }
  };
  const exhaustive = input.students.length <= 10;
  const feasibility = findFeasible(context, random, budget, consider, exhaustive);
  if (!best) return { status: feasibility.exhausted ? 'infeasible' : 'search_limit', diagnostics: { operations, seed } };
  if (!exhaustive || feasibility.limited) {
    const restarts = options.restarts ?? 10;
    for (let attempt = 0; attempt < restarts && operations < maxOperations && now() <= deadline; attempt++) {
      let initial = best.groups;
      if (attempt) findFeasible(context, random, budget, groups => { initial = groups; consider(groups); }, false);
      improve(initial, context, random, options.iterationsPerRestart ?? 700, budget, consider);
    }
  }
  const layout = createLayout(best.groups.map(group => group.map(index => context.students[index])), input.settings.respectVision, random, input.settings.groupColumns);
  const seated = layout.groups.flatMap(group => group.members).sort((a, b) => a.row - b.row || a.column - b.column);
  const frontVision = seated.filter(student => student.vision && student.row === 0).length;
  const metrics = { ...best.evaluated.metrics };
  if (metrics.vision !== null) metrics.vision = percent(frontVision / best.evaluated.details.visionTotal);
  // Validate the final answer independently before exposing it to the UI.
  const assignments = new Map(seated.map(student => [student.id, student.groupNumber]));
  const hardValid = seated.length === input.students.length && assignments.size === input.students.length
    && Math.max(...layout.groups.map(group => group.members.length)) - Math.min(...layout.groups.map(group => group.members.length)) <= 1
    && input.relations.filter(relation => relation.type === 'rival').every(relation => assignments.get(relation.first) !== assignments.get(relation.second));
  if (!hardValid) throw new Error('배치 결과의 필수 조건 검증에 실패했습니다.');
  metrics.balance = 100;
  return {
    status: 'success', layout, seated, metrics,
    details: { ...best.evaluated.details, visionFront: frontVision,
      means: layout.groups.map(group => group.members.reduce((sum, student) => sum + student.score, 0) / group.members.length) },
    diagnostics: { method: exhaustive && !feasibility.limited ? 'exhaustive' : 'search', candidates, operations, seed, elapsedMs: Math.round(now() - start), objective: best.evaluated.objective },
  };
}
