import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RuntimeService } from '../src/runtime/service.mjs';

test('session cleanup forgets managed provider runtime and execution-kernel state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-provider-lifecycle-'));
  const calls = [];
  const toolRuntime = {
    async run() { throw new Error('run should not be called'); },
    async forgetSession(sessionId) { calls.push(['forget', sessionId]); return true; },
    async close() { calls.push(['close']); },
  };
  const runtime = new RuntimeService({ databasePath: join(dir, 'db.sqlite3'), dataDir: dir, toolRuntime });
  try {
    const session = await runtime.handle('session.create');
    const result = await runtime.handle('session.cleanup', { sessionId: session.id });
    assert.deepEqual(calls, [['forget', session.id]]);
    assert.ok(result.purged.includes('provider-runtime'));
    assert.ok(result.purged.includes('execution-kernel-state'));
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
  assert.deepEqual(calls.at(-1), ['close']);
});

test('runtime close explicitly closes managed provider runtimes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-provider-close-'));
  let closes = 0;
  const runtime = new RuntimeService({
    databasePath: join(dir, 'db.sqlite3'),
    dataDir: dir,
    toolRuntime: {
      async run() { throw new Error('run should not be called'); },
      async forgetSession() { return false; },
      async close() { closes += 1; },
    },
  });
  try {
    await runtime.close();
    await runtime.close();
    assert.equal(closes, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
