import test from 'node:test';
import assert from 'node:assert/strict';
import { solveArrangement, createRandom, arrangementSignature } from '../arrangement.js';
import { groupsFromSavedRun, readSavedArrangements } from '../arrangement-history.js';

const settings = overrides => ({ groupCount: 2, scoreMode: 'ignore', friendMode: 'ignore', respectVision: false, avoidPrevious: false, ...overrides });
const students = scores => scores.map((score, index) => ({ id: String(index + 1), score, vision: false }));
const options = { seed: 42, maxTimeMs: 10000 };
const groupOf = result => new Map(result.seated.map(student => [student.id, student.groupNumber]));
function assertHardConditions(input, result) {
  assert.equal(result.status, 'success');
  assert.deepEqual(result.seated.map(student => student.id).sort(), input.students.map(student => student.id).sort());
  assert.equal(new Set(result.seated.map(student => student.id)).size, input.students.length);
  assert.equal(result.layout.groups.length, input.settings.groupCount);
  const sizes = result.layout.groups.map(group => group.members.length);
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1);
  for (const relation of input.relations.filter(relation => relation.type === 'rival')) {
    assert.notEqual(groupOf(result).get(relation.first), groupOf(result).get(relation.second));
  }
  assert.equal(new Set(result.seated.map(student => `${student.row},${student.column}`)).size, input.students.length);
}

test('regression: satisfying one rival relation cannot undo another', () => {
  const input = { students: students([4, 3, 2, 1]), settings: settings(), relations: [
    { first: '1', second: '3', type: 'rival' }, { first: '1', second: '2', type: 'rival' },
  ] };
  assertHardConditions(input, solveArrangement(input, options));
});
test('balanced averages and similar scores produce genuinely different groupings', () => {
  const input = { students: students([1, 1, 10, 10]), relations: [], settings: settings({ scoreMode: 'balanced' }) };
  const balanced = solveArrangement(input, options);
  assert.equal(balanced.details.meanGap, 0); assert.equal(balanced.metrics.score, 100);
  const similar = solveArrangement({ ...input, settings: settings({ scoreMode: 'similar' }) }, options);
  assert.equal(similar.details.withinDeviation, 0); assert.equal(similar.details.meanGap, 9);
  assert.notEqual(arrangementSignature(balanced.layout.groups.map(group => group.members)), arrangementSignature(similar.layout.groups.map(group => group.members)));
});
test('friends can be together, apart or ignored, while rivals remain mandatory', () => {
  for (const friendMode of ['together', 'apart', 'ignore']) {
    const input = { students: students([5, 5, 5, 5]), settings: settings({ friendMode }), relations: [
      { first: '1', second: '2', type: 'friend' }, { first: '1', second: '3', type: 'rival' },
    ] };
    const result = solveArrangement(input, options); assertHardConditions(input, result);
    if (friendMode !== 'ignore') {
      assert.equal(groupOf(result).get('1') === groupOf(result).get('2'), friendMode === 'together');
      assert.equal(result.metrics.friend, 100);
    } else assert.equal(result.metrics.friend, null);
  }
});
test('rivals win over an incompatible friend preference', () => {
  const input = { students: students([5, 5, 5, 5]), settings: settings({ friendMode: 'together' }), relations: [
    { first: '1', second: '2', type: 'friend' }, { first: '1', second: '3', type: 'friend' },
    { first: '2', second: '3', type: 'rival' },
  ] };
  const result = solveArrangement(input, options); assertHardConditions(input, result);
  assert.equal(result.metrics.friend, 50); assert.equal(result.metrics.rival, 100);
});
test('proof of impossibility is distinguished from a bounded search', () => {
  const input = { students: students([5, 5, 5, 5]), settings: settings({ groupCount: 3 }), relations: [] };
  for (let a = 1; a <= 4; a++) for (let b = a + 1; b <= 4; b++) input.relations.push({ first: String(a), second: String(b), type: 'rival' });
  assert.equal(solveArrangement(input, options).status, 'infeasible');
  const unfinished = solveArrangement({ ...input, relations: [] }, { ...options, maxOperations: 1 });
  assert.equal(unfinished.status, 'search_limit'); assert.equal(unfinished.seated, undefined);
});
test('vision placement retains groups and percentages measure physical front-row seats', () => {
  const list = students([5, 5, 5, 5, 5, 5]); list.forEach(student => { student.vision = true; });
  const input = { students: list, relations: [], settings: settings({ groupCount: 1, respectVision: true }) };
  const result = solveArrangement(input, options); assertHardConditions(input, result);
  assert.equal(result.details.visionFront, 2); assert.equal(result.metrics.vision, 33);
  assert.equal(result.layout.groups[0].members.length, 6);
});
test('vision students get front priority without destroying team membership', () => {
  const list = students(Array(12).fill(5)); list.slice(0, 4).forEach(student => { student.vision = true; });
  const input = { students: list, relations: [], settings: settings({ groupCount: 4, respectVision: true }) };
  const result = solveArrangement(input, { ...options, restarts: 4, iterationsPerRestart: 250 });
  assertHardConditions(input, result); assert.equal(result.metrics.vision, 100);
  assert.ok(result.seated.filter(student => student.vision).every(student => student.row === 0));
});
test('repeat avoidance uses all prior group pairs and ignores group numbering', () => {
  const input = { students: students([5, 5, 5, 5]), relations: [], settings: settings({ avoidPrevious: true }) };
  const result = solveArrangement(input, { ...options, previousArrangements: [[['1', '2'], ['3', '4']], [['4', '3'], ['2', '1']]] });
  assertHardConditions(input, result); assert.equal(result.details.historyCount, 1);
  assert.equal(result.details.repeatedPairs, 0); assert.equal(result.metrics.previous, 100);
});
test('without relevant history repeat avoidance is not reported as a fake success', () => {
  const input = { students: students([5, 5, 5, 5]), relations: [], settings: settings({ avoidPrevious: true }) };
  assert.equal(solveArrangement(input, options).metrics.previous, null);
});
test('single seats and one group work; every student appears exactly once', () => {
  for (const count of [1, 7, 60]) for (const groupCount of [1, count]) {
    const input = { students: students(Array(count).fill(5)), relations: [], settings: settings({ groupCount }) };
    assertHardConditions(input, solveArrangement(input, { ...options, restarts: 1, iterationsPerRestart: 20 }));
  }
});

test('25 individual seats support one column, a 5 by 5 square and a single row', () => {
  for (const groupColumns of [1, 5, 25]) {
    const input = { students: students(Array(25).fill(5)), relations: [], settings: settings({ groupCount: 25, groupColumns }) };
    const result = solveArrangement(input, options); assertHardConditions(input, result);
    assert.equal(result.layout.groupColumns, groupColumns);
    assert.equal(result.layout.seatColumns, 1);
    assert.equal(new Set(result.seated.map(student => student.column)).size, groupColumns);
    assert.equal(new Set(result.seated.map(student => student.row)).size, 25 / groupColumns);
    for (let row = 0; row < 25 / groupColumns; row++) {
      assert.equal(result.seated.filter(student => student.row === row).length, groupColumns);
    }
  }
});

test('a partial final row contains only the remaining students', () => {
  const input = { students: students(Array(26).fill(5)), relations: [], settings: settings({ groupCount: 26, groupColumns: 5 }) };
  const result = solveArrangement(input, options); assertHardConditions(input, result);
  assert.equal(Math.max(...result.seated.map(student => student.row)), 5);
  assert.equal(result.seated.filter(student => student.row === 5).length, 1);
  assert.ok(result.seated.every(student => student.column >= 0 && student.column < 5));
});

test('selected columns affect physical front-row capacity for individual seats and teams', () => {
  for (const [count, groupCount, seatColumns] of [[25, 25, 1], [18, 6, 2]]) {
    const list = students(Array(count).fill(5)); list.forEach(student => { student.vision = true; });
    for (const groupColumns of [1, 5]) {
      const input = { students: list, relations: [], settings: settings({ groupCount, groupColumns, respectVision: true }) };
      const result = solveArrangement(input, { ...options, restarts: 1, iterationsPerRestart: 20 });
      assertHardConditions(input, result);
      const front = result.seated.filter(student => student.row === 0).length;
      assert.equal(front, groupColumns * seatColumns);
      assert.equal(result.details.visionFront, front);
      assert.equal(result.metrics.vision, Math.round(100 * front / count));
      assert.equal(result.layout.groupColumns, groupColumns);
    }
  }
});

test('legacy inputs retain the old three-column layout and invalid columns produce no seats', () => {
  const input = { students: students(Array(25).fill(5)), relations: [], settings: settings({ groupCount: 25 }) };
  assert.equal(solveArrangement(input, options).layout.groupColumns, 3);
  for (const groupColumns of [0, 2.5, 26, NaN]) {
    const result = solveArrangement({ ...input, settings: { ...input.settings, groupColumns } }, options);
    assert.equal(result.status, 'invalid'); assert.equal(result.seated, undefined);
  }
});
test('randomized feasible classes preserve all hard conditions, including 60 students', () => {
  const random = createRandom(9123);
  for (const count of [5, 8, 15, 30, 60]) for (const groupCount of [2, 3, 5]) {
    const list = students(Array.from({ length: count }, () => 1 + Math.floor(random() * 10)));
    const relations = [];
    for (let a = 0; a < count; a++) for (let b = a + 1; b < count; b++) {
      if (a % groupCount !== b % groupCount && random() < 0.2) relations.push({ first: list[a].id, second: list[b].id, type: 'rival' });
    }
    const input = { students: list, relations, settings: settings({ groupCount, scoreMode: 'balanced' }) };
    assertHardConditions(input, solveArrangement(input, { ...options, seed: count * 10 + groupCount, restarts: 2, iterationsPerRestart: 100 }));
  }
});
test('rerolling is reproducible with a seed and varies when the seed changes', () => {
  const input = { students: students(Array(8).fill(5)), relations: [], settings: settings({ groupCount: 4 }) };
  const first = solveArrangement(input, options);
  assert.deepEqual(first.seated, solveArrangement(input, options).seated);
  assert.notDeepEqual(first.seated, solveArrangement(input, { ...options, seed: 900 }).seated);
});
test('solver never mutates students, relationships, settings or previous results', () => {
  const input = { students: students([1, 2, 3, 4]), relations: [], settings: settings({ avoidPrevious: true }) };
  const history = [[['1', '2'], ['3', '4']]];
  const original = structuredClone({ input, history });
  solveArrangement(input, { ...options, previousArrangements: history });
  assert.deepEqual({ input, history }, original);
});
test('saved run conversion uses student numbers rather than internal database IDs', () => {
  assert.deepEqual(groupsFromSavedRun({ arrangement_assignments: [
    { group_number: 2, students: { student_number: '2501' } },
    { group_number: 2, students: { student_number: '2502' } },
    { group_number: 1, students: null },
  ] }), [['2501', '2502']]);
});
test('a history read error propagates rather than pretending the database has no history', async () => {
  const client = { from() { return this; }, select() { return this; }, eq() { return this; }, order() { return this; }, limit() { return this; },
    abortSignal() { return Promise.resolve({ data: null, error: new Error('history unavailable') }); } };
  await assert.rejects(readSavedArrangements(client, 'owner', 'class', undefined), /history unavailable/);
});
