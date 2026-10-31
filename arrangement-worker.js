import { solveArrangement } from './arrangement.js';

self.onmessage = event => {
  try { self.postMessage({ result: solveArrangement(event.data.input, event.data.options) }); }
  catch (error) { self.postMessage({ error: error.message }); }
};
