import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/renderer/execution-ui.mjs', import.meta.url), 'utf8');

test('running composer exposes explicit runtime queue and steer paths', () => {
  assert.match(source, /setDeliveryMode\('queue'\)/);
  assert.match(source, /cuppet\.steer\.interrupt/);
  assert.match(source, /window\.cuppet\.sessions\.send\(sessionId, text\)/);
  assert.match(source, /event\.type === 'queue\.queued'/);
  assert.match(source, /event\.type === 'queue\.dispatched'/);
});

test('activity surface consumes tool, validation, and TST diff evidence', () => {
  assert.match(source, /event\.type === 'tool\.started'/);
  assert.match(source, /event\.type === 'tool\.finished'/);
  assert.match(source, /event\.type === 'validation\.completed'/);
  assert.match(source, /TST EDIT BATCH \(\?:PREPARED\|APPLIED\)/);
  assert.match(source, /Show changes/);
});
