import test from 'node:test';
import assert from 'node:assert/strict';
import { validateInput, groupSummary, layoutSummary, settingsForClass, settingsFromClass } from '../input-model.js';

const input = () => ({
  students: [{ id: '2501', score: 1, vision: true }, { id: '2502', score: 10, vision: false }],
  relations: [],
  settings: { groupCount: 2, groupColumns: 2, scoreMode: 'balanced', friendMode: 'together', respectVision: true, avoidPrevious: false },
});

test('valid plan inputs and all preference combinations', () => {
  for (const scoreMode of ['balanced', 'similar', 'ignore']) {
    for (const friendMode of ['together', 'apart', 'ignore']) {
      const data = input();
      Object.assign(data.settings, { scoreMode, friendMode });
      assert.deepEqual(validateInput(data), []);
    }
  }
});
test('scores reject blanks, fractions and out-of-range numbers instead of silently changing them', () => {
  for (const score of [NaN, 0, 11, 2.5, Infinity]) {
    const data = input(); data.students[0].score = score;
    assert.ok(validateInput(data).some(issue => issue.field === 'student-score'));
  }
});
test('student numbers must be filled, numeric and unique', () => {
  for (const id of ['', 'abc', '<img src=x>', '2502']) {
    const data = input(); data.students[0].id = id;
    assert.ok(validateInput(data).some(issue => issue.field === 'student-id'));
  }
});
test('group count must be an integer no greater than the student count', () => {
  for (const groupCount of [NaN, 0, -1, 2.5, 3]) {
    const data = input(); data.settings.groupCount = groupCount;
    assert.ok(validateInput(data).some(issue => issue.field === 'groupCount'));
  }
});
test('student count changes must be valid and explicitly applied', () => {
  for (const studentCount of [0, 2.5, 61, NaN, 3]) {
    assert.ok(validateInput({ ...input(), studentCount }).some(issue => issue.field === 'studentCount'));
  }
});
test('single-student and 60-student individual seating are valid', () => {
  for (const count of [1, 60]) {
    const data = input();
    data.students = Array.from({ length: count }, (_, i) => ({ id: String(i + 1), score: 5 }));
    data.settings.groupCount = count;
    data.settings.groupColumns = Math.min(3, count);
    assert.deepEqual(validateInput(data), []);
  }
});
test('self relations and missing students are reported', () => {
  for (const second of ['2501', '', '9999']) {
    const data = input(); data.relations = [{ first: '2501', second, type: 'friend' }];
    assert.ok(validateInput(data).length > 0);
  }
});
test('reversed duplicate and contradictory relationships are rejected', () => {
  for (const type of ['friend', 'rival']) {
    const data = input();
    data.relations = [{ first: '2501', second: '2502', type: 'friend' }, { first: '2502', second: '2501', type }];
    assert.ok(validateInput(data).some(issue => issue.field === 'relation-type'));
  }
});
test('rival relations cannot be entered for a single group, even if friends are ignored', () => {
  const data = input(); data.settings.groupCount = 1; data.settings.friendMode = 'ignore';
  data.relations = [{ first: '2501', second: '2502', type: 'rival' }];
  assert.ok(validateInput(data).some(issue => issue.field === 'groupCount'));
});
test('unequal group size guidance is accurate', () => {
  assert.equal(groupSummary(5, 2), '5명 → 2개 그룹 · 2명 그룹 1개, 3명 그룹 1개');
  assert.equal(groupSummary(6, 3), '6명 → 3개 그룹 · 그룹당 2명');
});
test('friend mode round-trips through the database payload', () => {
  for (const friendMode of ['together', 'apart', 'ignore']) {
    const settings = { ...input().settings, friendMode };
    assert.deepEqual(settingsFromClass(settingsForClass(settings)), settings);
  }
});
test('legacy friend booleans retain their meaning', () => {
  assert.equal(settingsFromClass({ respect_friend: false }).friendMode, 'ignore');
  assert.equal(settingsFromClass({ respect_friend: true }).friendMode, 'together');
});

test('group columns reject blanks, fractions and numbers beyond the group count', () => {
  for (const groupColumns of [NaN, 0, -1, 1.5, 3, Infinity, null]) {
    const data = input(); data.settings.groupColumns = groupColumns;
    assert.ok(validateInput(data).some(issue => issue.field === 'groupColumns'));
  }
  for (const groupColumns of [1, 2]) {
    const data = input(); data.settings.groupColumns = groupColumns;
    assert.deepEqual(validateInput(data), []);
  }
});

test('column settings persist and legacy classes retain their layout', () => {
  const settings = { ...input().settings, groupCount: 25, groupColumns: 5 };
  assert.deepEqual(settingsFromClass(settingsForClass(settings)), settings);
  for (const group_count of [1, 2, 25]) {
    assert.equal(settingsFromClass({ group_count }).groupColumns, Math.min(3, group_count));
  }
  const data = input(); delete data.settings.groupColumns;
  assert.deepEqual(validateInput(data), []);
});

test('layout guidance reports selected columns and a partially filled last row', () => {
  assert.equal(layoutSummary(25, 5), '그룹 배치: 가로 5열 × 세로 5줄');
  assert.equal(layoutSummary(26, 5), '그룹 배치: 가로 5열 × 세로 6줄 · 마지막 줄 1개 그룹');
  assert.match(layoutSummary(2, 3), /올바르게/);
});
