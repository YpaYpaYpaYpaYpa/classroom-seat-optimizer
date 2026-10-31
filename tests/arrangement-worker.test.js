import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

// Run the actual worker entry point with Node's transport. The browser worker
// API is the only shim; the solver and message/error handling remain unchanged.
function runWorker(input) {
  const entry = new URL('../arrangement-worker.js', import.meta.url).href;
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    globalThis.self = { postMessage: message => parentPort.postMessage(message) };
    import(${JSON.stringify(entry)}).then(() => {
      parentPort.on('message', data => self.onmessage({ data }));
      parentPort.postMessage({ ready: true });
    }).catch(error => { throw error; });
  `, { eval: true });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { worker.terminate(); reject(new Error('worker timeout')); }, 10000);
    worker.on('error', error => { clearTimeout(timeout); worker.terminate(); reject(error); });
    worker.on('message', message => {
      if (message.ready) { worker.postMessage({ input, options: { seed: 8 } }); return; }
      clearTimeout(timeout); worker.terminate(); resolve(message);
    });
  });
}

test('actual calculation worker receives input and returns a serializable, valid result', async () => {
  const input = {
    students: Array.from({ length: 30 }, (_, index) => ({ id: String(index + 1), score: index % 10 + 1, vision: index % 5 === 0 })),
    relations: [{ first: '1', second: '2', type: 'rival' }],
    settings: { groupCount: 6, scoreMode: 'balanced', friendMode: 'ignore', respectVision: true, avoidPrevious: false },
  };
  const response = await runWorker(input);
  assert.equal(response.error, undefined); assert.equal(response.result.status, 'success');
  assert.equal(response.result.seated.length, 30);
  assert.notEqual(response.result.seated.find(student => student.id === '1').groupNumber, response.result.seated.find(student => student.id === '2').groupNumber);
  assert.ok(response.result.layout.groups.every(group => group.members.length === 5));
});

test('invalid inputs are returned without crashing the worker', async () => {
  const response = await runWorker({ students: [], relations: [], settings: { groupCount: 1 } });
  assert.equal(response.error, undefined); assert.equal(response.result.status, 'invalid');
});

test('the actual worker carries a five-column setting through to a 5 by 5 result', async () => {
  const response = await runWorker({
    students: Array.from({ length: 25 }, (_, index) => ({ id: String(index + 1), score: 5, vision: true })),
    relations: [],
    settings: { groupCount: 25, groupColumns: 5, scoreMode: 'ignore', friendMode: 'ignore', respectVision: true, avoidPrevious: false },
  });
  assert.equal(response.error, undefined); assert.equal(response.result.status, 'success');
  assert.equal(response.result.layout.groupColumns, 5);
  assert.equal(response.result.details.visionFront, 5);
  for (let row = 0; row < 5; row++) assert.equal(response.result.seated.filter(student => student.row === row).length, 5);
});
