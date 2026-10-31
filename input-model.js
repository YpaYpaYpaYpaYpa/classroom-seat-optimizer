export const MAX_STUDENTS = 60;

export function validateInput({ students, relations, settings, studentCount = students.length }) {
  const issues = [];
  const issue = (field, message, index) => issues.push({ field, message, index });
  if (students.length < 1 || students.length > MAX_STUDENTS) {
    issue('studentCount', `학생 수는 1~${MAX_STUDENTS}명이어야 합니다.`);
  }
  if (!Number.isInteger(studentCount) || studentCount < 1 || studentCount > MAX_STUDENTS) {
    issue('studentCount', `학생 수는 1~${MAX_STUDENTS} 사이의 정수로 입력해 주세요.`);
  } else if (studentCount !== students.length) {
    issue('studentCount', '학생 수를 변경한 뒤에는 ‘입력칸 적용’을 눌러 주세요.');
  }
  const studentIds = new Set();
  students.forEach((student, index) => {
    if (!/^\d+$/.test(student.id)) {
      issue('student-id', `${index + 1}번째 학생의 학번을 숫자로 입력해 주세요.`, index);
    } else if (studentIds.has(student.id)) {
      issue('student-id', `학번 ${student.id}이 중복되었습니다.`, index);
    }
    studentIds.add(student.id);
    if (!Number.isInteger(student.score) || student.score < 1 || student.score > 10) {
      issue('student-score', `${index + 1}번째 학생의 성적은 1~10 사이의 정수여야 합니다.`, index);
    }
  });
  const pairs = new Map();
  relations.forEach((relation, index) => {
    if (!relation.first || !studentIds.has(relation.first)) {
      issue('relation-first', `${index + 1}번째 관계의 첫 번째 학생을 선택해 주세요.`, index);
    }
    if (!relation.second || !studentIds.has(relation.second)) {
      issue('relation-second', `${index + 1}번째 관계의 두 번째 학생을 선택해 주세요.`, index);
    }
    if (!['friend', 'rival'].includes(relation.type)) {
      issue('relation-type', `${index + 1}번째 관계 유형을 선택해 주세요.`, index);
    }
    if (!relation.first || !relation.second) return;
    if (relation.first === relation.second) {
      issue('relation-second', '서로 다른 두 학생을 선택해 주세요.', index);
      return;
    }
    const key = JSON.stringify([relation.first, relation.second].sort());
    if (pairs.has(key)) {
      issue('relation-type', pairs.get(key) === relation.type
        ? `${relation.first}–${relation.second} 관계가 중복되었습니다. 순서를 바꿔도 같은 관계입니다.`
        : `${relation.first}–${relation.second}을 친구와 앙숙으로 동시에 지정할 수 없습니다.`, index);
    }
    pairs.set(key, relation.type);
  });
  if (!Number.isInteger(settings.groupCount) || settings.groupCount < 1 || settings.groupCount > students.length) {
    issue('groupCount', `그룹 수는 1~${students.length} 사이의 정수여야 합니다.`);
  } else if (settings.groupCount === 1 && relations.some(relation => relation.type === 'rival')) {
    issue('groupCount', '앙숙 관계가 있으면 서로 다른 그룹이 필요합니다. 그룹 수를 2 이상으로 입력해 주세요.');
  }
  if (settings.groupColumns !== undefined && (!Number.isInteger(settings.groupColumns)
    || settings.groupColumns < 1 || settings.groupColumns > settings.groupCount || settings.groupColumns > MAX_STUDENTS)) {
    issue('groupColumns', '한 줄의 그룹 수는 1 이상, 전체 그룹 수 이하의 정수여야 합니다.');
  }
  if (!['balanced', 'similar', 'ignore'].includes(settings.scoreMode)) issue('scoreMode', '성적 분포 방식을 선택해 주세요.');
  if (!['together', 'apart', 'ignore'].includes(settings.friendMode)) issue('friendMode', '친구 관계 반영 방식을 선택해 주세요.');
  return issues;
}

export function groupSummary(studentCount, groupCount) {
  if (!Number.isInteger(groupCount) || groupCount < 1 || groupCount > studentCount) {
    return `학생 ${studentCount}명 기준, 그룹 수는 1~${studentCount} 사이의 정수입니다.`;
  }
  const small = Math.floor(studentCount / groupCount);
  const largerGroups = studentCount % groupCount;
  return largerGroups === 0
    ? `${studentCount}명 → ${groupCount}개 그룹 · 그룹당 ${small}명`
    : `${studentCount}명 → ${groupCount}개 그룹 · ${small}명 그룹 ${groupCount - largerGroups}개, ${small + 1}명 그룹 ${largerGroups}개`;
}

// Records saved before this setting existed retain the old three-column layout.
export function resolveGroupColumns(groupCount, groupColumns) {
  return Math.min(groupColumns ?? 3, groupCount);
}

export function layoutSummary(groupCount, groupColumns) {
  if (!Number.isInteger(groupCount) || groupCount < 1 || !Number.isInteger(groupColumns)
    || groupColumns < 1 || groupColumns > groupCount) return '전체 그룹 수와 한 줄의 그룹 수를 올바르게 입력해 주세요.';
  const rows = Math.ceil(groupCount / groupColumns);
  const lastRow = groupCount % groupColumns;
  return `그룹 배치: 가로 ${groupColumns}열 × 세로 ${rows}줄${lastRow ? ` · 마지막 줄 ${lastRow}개 그룹` : ''}`;
}

// Existing saved classes used a boolean; retain its meaning when loading them.
export function settingsFromClass(classroom) {
  return {
    groupCount: classroom.group_count,
    groupColumns: resolveGroupColumns(classroom.group_count, classroom.group_columns),
    scoreMode: classroom.score_mode,
    friendMode: classroom.friend_mode ?? (classroom.respect_friend ? 'together' : 'ignore'),
    respectVision: classroom.respect_vision,
    avoidPrevious: classroom.avoid_previous,
  };
}

export function settingsForClass(settings) {
  return {
    group_count: settings.groupCount,
    group_columns: resolveGroupColumns(settings.groupCount, settings.groupColumns),
    score_mode: settings.scoreMode,
    friend_mode: settings.friendMode,
    respect_friend: settings.friendMode !== 'ignore',
    respect_vision: settings.respectVision,
    avoid_previous: settings.avoidPrevious,
  };
}
