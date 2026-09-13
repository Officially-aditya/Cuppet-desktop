import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/runtime/main.mjs', import.meta.url), 'utf8');
const chatPane = await readFile(new URL('../src/renderer/react/ChatPane.tsx', import.meta.url), 'utf8');

test('runtime host serializes queued turns through the durable turn store', () => {
  assert.match(source, /case 'session\.send': return sendOrQueue\(params\)/);
  assert.match(source, /new TurnStore\(join\(dataDir, 'turn-state\.sqlite3'\)\)/);
  assert.match(source, /turnStore\.enqueue\(/);
  assert.match(source, /turnStore\.claimNext\(/);
  assert.match(source, /turnStore\.completeQueue\(/);
  assert.match(source, /turnStore\.failQueue\(/);
  assert.match(source, /type: 'queue\.queued'/);
  assert.match(source, /type: 'queue\.started'/);
  assert.match(source, /type: 'queue\.dispatched'/);
  assert.match(source, /type: 'queue\.failed'/);
});

test('renderer delegates queue ownership to the runtime', () => {
  assert.doesNotMatch(chatPane, /queuedBySession/);
  assert.doesNotMatch(chatPane, /queueDispatching/);
  assert.doesNotMatch(chatPane, /type QueuedMessage/);
  assert.match(chatPane, /The runtime owns queueing/);
});

test('remote manager calls through the same runtime host boundary', () => {
  assert.match(source, /new RemoteManager\(\{ dataDir, call: \(method, params\) => handle\(method, params\)/);
});
