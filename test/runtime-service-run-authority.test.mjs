import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

test('service falls back to live execution state when no durable projection is injected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-runtime-live-fallback-'));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const runtime = new RuntimeService({
    databasePath: join(dir, 'db.sqlite3'),
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
    await runtime.handle('session.send', { sessionId: session.id, text: 'first', provider: {} });
    await assert.rejects(
      () => runtime.handle('session.send', { sessionId: session.id, text: 'second', provider: {} }),
      /already generating/,
    );
    assert.equal((await runtime.handle('health')).activeRuns, 1);
    assert.equal((await runtime.handle('session.stop', { sessionId: session.id })).stopped, true);
  } finally {
    release?.();
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});
