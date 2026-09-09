import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/renderer/execution-ui.mjs', import.meta.url), 'utf8');

test('running composer exposes explicit queue and steer paths', () => {
  assert.match(source, /setDeliveryMode\('queue'\)/);
  assert.match(source, /cuppet\.steer\.interrupt/);
  assert.match(source, /drainQueue\(sessionId\)/);
  assert.match(source, /window\.cuppet\.sessions\.send\(sessionId, item\.text\)/);
});

test('activity surface consumes tool, validation, and diff evidence', () => {
  assert.match(source, /event\.type === 'tool\.started'/);
  assert.match(source, /event\.type === 'tool\.finished'/);
  assert.match(source, /event\.type === 'validation\.completed'/);
  assert.match(source, /typeof value\.diff === 'string'/);
  assert.match(source, /Show changes/);
});
