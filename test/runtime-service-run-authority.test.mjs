import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationDatabase } from '../src/runtime/database.mjs';
import { RuntimeService } from '../src/runtime/service.mjs';

function inertProvider(counter) {
  return () => ({
    async stream() {
      counter.calls += 1;
      return { text: '' };
    },
  });
}

test('durable run state blocks send admission without a live execution handle', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-runtime-run-authority-'));
  const active = new Set();
  const provider = { calls: 0 };
  const runtime = new RuntimeService({
    databasePath: join(dir, 'db.sqlite3'),
    runState: { isActive: (sessionId) => active.has(sessionId) },
    providerFactory: inertProvider(provider),
  });

  try {
    const session = await runtime.handle('session.create');
    active.add(session.id);

    await assert.rejects(
      () => runtime.handle('session.send', { sessionId: session.id, text: 'must not start', provider: {} }),
      /already generating/,
    );
    assert.equal(provider.calls, 0);
    assert.equal((await runtime.handle('health')).activeRuns, 0, 'durable activity must not fabricate a live controller');
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('standalone service owns a durable run projection instead of using live execution state as authority', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-runtime-owned-run-authority-'));
  const path = join(dir, 'db.sqlite3');
  const database = new ConversationDatabase(path);
  const repository = database.sqlRepository();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const runtime = new RuntimeService({
    database,
    databasePath: path,
    providerFactory: () => ({
      async stream(_messages, { signal }) {
        await Promise.race([
          gate,
          new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })),
        ]);
        if (signal.aborted) {
          const error = new Error('stopped');
          error.name = 'AbortError';
          throw error;
        }
        return { text: '' };
      },
    }),
  });

  try {
    const session = await runtime.handle('session.create');
    const first = await runtime.handle('session.send', { sessionId: session.id, text: 'first', provider: {} });
    const running = repository.prepare('SELECT status FROM runs WHERE run_id=?').get(first.messageId);
    assert.equal(running?.status, 'running', 'standalone RuntimeService must project the run durably before returning send acceptance');

    await assert.rejects(
      () => runtime.handle('session.send', { sessionId: session.id, text: 'second', provider: {} }),
      /already generating/,
    );
    assert.equal((await runtime.handle('health')).activeRuns, 1);
    assert.equal((await runtime.handle('session.stop', { sessionId: session.id })).stopped, true);

    await waitUntil(() => {
      const row = repository.prepare('SELECT status FROM runs WHERE run_id=?').get(first.messageId);
      return row?.status === 'stopped';
    });
    assert.equal(repository.prepare('SELECT status FROM runs WHERE run_id=?').get(first.messageId)?.status, 'stopped');
  } finally {
    release?.();
    await runtime.close();
    database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function waitUntil(predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}
