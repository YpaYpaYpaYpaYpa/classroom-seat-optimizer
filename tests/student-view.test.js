import test from 'node:test';
import assert from 'node:assert/strict';
import { studentViewModel } from '../student-view.js';

test('student view keeps seat order and enabled indicators while excluding names, scores and relations', () => {
  const input = {
    layout: { groupColumns: 2, seatColumns: 2, blockRows: 1, groups: [
      { groupNumber: 1, average: 9, members: [{ id: '2501', name: '학생 이름', score: 10, vision: true, height: true }, { id: '2502', score: 8, vision: false }] },
      { groupNumber: 2, members: [{ id: '2503', score: 1, height: true }] },
    ] },
    metrics: { score: 90 }, relations: [{ first: '2501', second: '2502', type: 'rival' }],
  };
  const copy = structuredClone(input);
  assert.deepEqual(studentViewModel(input, { respectVision: true, respectHeight: true }), {
    groupColumns: 2, seatColumns: 2, blockRows: 1,
    groups: [
      { groupNumber: 1, members: [{ id: '2501', vision: true, height: true }, { id: '2502', vision: false, height: false }] },
      { groupNumber: 2, members: [{ id: '2503', vision: false, height: true }] },
    ],
  });
  for (const [settings, expected] of [
    [{ respectVision: true, respectHeight: false }, { id: '2501', vision: true, height: false }],
    [{ respectVision: false, respectHeight: true }, { id: '2501', vision: false, height: true }],
    [{ respectVision: false, respectHeight: false }, { id: '2501', vision: false, height: false }],
  ]) assert.deepEqual(studentViewModel(input, settings).groups[0].members[0], expected);
  assert.deepEqual(input, copy);
});
