import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/runtime/main.mjs', import.meta.url), 'utf8');

test('runtime host serializes second turns and exposes queue lifecycle events', () => {
  assert.match(source, /case 'session\.send': return sendOrQueue\(params\)/);
  assert.match(source, /activeSessions\.has\(sessionId\)/);
  assert.match(source, /type: 'queue\.queued'/);
  assert.match(source, /type: 'queue\.started'/);
  assert.match(source, /type: 'queue\.dispatched'/);
  assert.match(source, /type: 'queue\.failed'/);
});

test('remote manager calls through the same runtime host boundary', () => {
  assert.match(source, /new RemoteManager\(\{ dataDir, call: \(method, params\) => handle\(method, params\)/);
});
