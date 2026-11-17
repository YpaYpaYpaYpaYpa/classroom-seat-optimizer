import test from 'node:test';
import assert from 'node:assert/strict';
import { studentViewModel } from '../student-view.js';

test('student view keeps the exact groups and seats but discards all private student and result data', () => {
  const input = {
    layout: { groupColumns: 2, seatColumns: 2, blockRows: 1, groups: [
      { groupNumber: 1, average: 9, members: [{ id: '2501', score: 10, vision: true, height: true }, { id: '2502', score: 8, vision: false }] },
      { groupNumber: 2, members: [{ id: '2503', score: 1, height: true }] },
    ] },
    metrics: { score: 90 }, relations: [{ first: '2501', second: '2502', type: 'rival' }],
  };
  const copy = structuredClone(input);
  assert.deepEqual(studentViewModel(input), {
    groupColumns: 2, seatColumns: 2, blockRows: 1,
    groups: [{ groupNumber: 1, members: [{ id: '2501' }, { id: '2502' }] }, { groupNumber: 2, members: [{ id: '2503' }] }],
  });
  assert.deepEqual(input, copy);
});
