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

for (const status of ['complete', 'error', 'stopped']) {
  test(`${status} runs become idle while TST completion housekeeping is pending`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cuppet-run-completion-'));
    const events = [];
    const cleanupSessions = [];
    const recordedTurns = [];
    let releaseCleanup;
    const cleanup = new Promise((resolve) => { releaseCleanup = resolve; });
    let completed;
    let messageCompleted = new Promise((resolve) => { completed = resolve; });
    let runs = 0;
    const runtime = new RuntimeService({
      databasePath: join(dir, 'db.sqlite3'),
      dataDir: dir,
      emit(event) {
        events.push(event);
        if (event.type === 'message.completed') completed(event);
      },
      tst: {
        configured: true,
        turnCompleted(sessionId) { cleanupSessions.push(sessionId); return cleanup; },
      },
      contextCompiler: { async compile({ messages }) { return { messages }; } },
      providerFactory: () => ({ async stream() { return { text: 'Completion test' }; } }),
      toolRuntime: {
        async run({ onDelta }) {
          await onDelta('done');
          if (++runs === 1 && status !== 'complete') {
            throw Object.assign(new Error('Test run ended'), { name: status === 'stopped' ? 'AbortError' : 'Error' });
          }
        },
      },
      backgroundFactory: () => ({
        async ready() {},
        foregroundStarted() {},
        setProviderConfig() {},
        async recordTurn(turn) { recordedTurns.push(turn); },
        foregroundIdle() {},
        async close() {},
      }),
    });
    try {
      const session = await runtime.handle('session.create');
      const first = await runtime.handle('session.send', { sessionId: session.id, text: 'first' });
      const completion = await messageCompleted;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(completion.message.status, status);
      assert.ok(events.some((event) => event.type === 'run.finished' && event.messageId === first.messageId), 'finish the run without waiting for TST');
      const health = await runtime.handle('health');
      assert.equal(health.activeRuns, 0);
      assert.equal(health.liveExecutions, 0);
      assert.equal(recordedTurns.length, status === 'complete' ? 1 : 0);

      messageCompleted = new Promise((resolve) => { completed = resolve; });
      const next = await runtime.handle('session.send', { sessionId: session.id, text: 'next' });
      assert.equal(next.accepted, true);
      await messageCompleted;
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(events.some((event) => event.type === 'run.finished' && event.messageId === next.messageId));
      assert.deepEqual(cleanupSessions, [session.id, session.id]);
      assert.equal((await runtime.handle('health')).activeRuns, 0);
    } finally {
      releaseCleanup();
      await new Promise((resolve) => setImmediate(resolve));
      await runtime.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
