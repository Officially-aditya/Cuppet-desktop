import assert from 'node:assert/strict';
import test from 'node:test';
import { createReasoningRenderer } from '../src/renderer/react/reasoning-renderer.ts';

const previousWorker = globalThis.Worker;
const workers = [];
class FakeWorker {
  constructor(url, options) { this.url = url; this.options = options; this.messages = []; this.terminated = false; workers.push(this); }
  postMessage(message) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  reply(request, rendered = { blocks: ['<p>Done</p>'], tail: '' }) { this.onmessage({ data: { ...request, rendered } }); }
}
globalThis.Worker = FakeWorker;
test.after(() => { if (previousWorker === undefined) delete globalThis.Worker; else globalThis.Worker = previousWorker; });

test('parsing is delegated to one module worker shared by open thoughts', () => {
  const firstResults = [], secondResults = [];
  const first = createReasoningRenderer((value) => firstResults.push(value), assert.fail);
  const worker = workers.at(-1);
  const second = createReasoningRenderer((value) => secondResults.push(value), assert.fail);
  first.render('First thought', false);
  second.render('Second thought', true);
  assert.equal(workers.at(-1), worker);
  assert.equal(worker.options.type, 'module');
  assert.match(worker.url.pathname, /reasoning-markdown\.worker\.ts$/);
  const [a, b] = worker.messages;
  worker.reply(b);
  worker.reply(a);
  assert.equal(firstResults[0].content, 'First thought');
  assert.equal(secondResults[0].content, 'Second thought');
  first.dispose();
  assert.equal(worker.terminated, false);
  second.dispose();
  assert.equal(worker.terminated, true);
});

test('fast streaming coalesces queued updates instead of flooding the worker', () => {
  const received = [];
  const renderer = createReasoningRenderer((value) => received.push(value), assert.fail);
  const worker = workers.at(-1);
  renderer.render('first', true);
  for (let index = 0; index < 100; index++) renderer.render(`latest ${index}`, true);
  assert.equal(worker.messages.length, 1);
  worker.reply(worker.messages[0]);
  assert.equal(worker.messages.length, 2);
  assert.equal(worker.messages[1].content, 'latest 99');
  worker.reply(worker.messages[1]);
  assert.deepEqual(received.map((value) => value.content), ['first', 'latest 99']);
  renderer.dispose();
});

test('a collapsed thought never receives a stale worker result', () => {
  const renderer = createReasoningRenderer(() => assert.fail('Disposed renderer received a result'), assert.fail);
  const worker = workers.at(-1);
  renderer.render('thought', false);
  const request = worker.messages[0];
  renderer.dispose();
  worker.reply(request);
  assert.equal(worker.terminated, true);
});

test('worker failure releases clients and the next open can start a new worker', () => {
  let failures = 0;
  const renderer = createReasoningRenderer(assert.fail, () => failures++);
  const worker = workers.at(-1);
  renderer.render('thought', true);
  worker.onerror();
  assert.equal(failures, 1);
  assert.equal(worker.terminated, true);
  const next = createReasoningRenderer(() => {}, assert.fail);
  assert.notEqual(workers.at(-1), worker);
  renderer.dispose();
  next.dispose();
});
