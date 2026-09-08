import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeService } from '../src/runtime/service.mjs';

function waitFor(events, predicate, timeout = 1500) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const found = events.find(predicate);
      if (found) { clearInterval(timer); resolve(found); }
      else if (Date.now() - started > timeout) { clearInterval(timer); reject(new Error('timed out waiting for event')); }
    }, 5);
  });
}

function backgroundStub() {
  return { stats: { paused: false, queued: 0, running: false }, async ready() {}, pause() {}, resume() {}, foregroundStarted() {}, foregroundIdle() {}, setProviderConfig() {}, async recordTurn() {}, async flushNow() { return { status: 'empty', candidates: 0 }; }, async close() {} };
}

test('runtime sends detached Cuppet context to provider but persists only visible transcript', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-b1-runtime-')); const events = []; const providerRequests = [];
  const tst = {
    configured: true,
    status: { configured: true, connected: true, protocol: 'cuppet.tst.v3' },
    async prepareContext() { return { observation_complete: true, stm: [{ key: 'goal', value: 'preserve detached context' }] }; },
    async turnCompleted() {}, async refreshStm() { return { records: [{ key: 'goal', value: 'preserve detached context' }] }; }, close() {},
  };
  const providerFactory = () => ({ async stream(messages, { onDelta }) { providerRequests.push(structuredClone(messages)); await onDelta('done'); return { text: 'done' }; } });
  const runtime = new RuntimeService({ databasePath: join(dir, 'db.sqlite3'), dataDir: dir, emit: (event) => events.push(event), providerFactory, tst, backgroundFactory: backgroundStub });
  try {
    const session = await runtime.handle('session.create');
    await runtime.handle('session.send', { sessionId: session.id, text: 'Implement the runtime', provider: { apiKey: 'x', model: 'm', contextWindow: 100000 } });
    await waitFor(events, (event) => event.type === 'run.finished');
    assert.equal(providerRequests[0].some((message) => message.role === 'system' && /CUPPET_CONTEXT/.test(message.content)), true);
    const restored = await runtime.handle('session.get', { sessionId: session.id });
    assert.deepEqual(restored.messages.map((message) => [message.role, message.content]), [['user', 'Implement the runtime'], ['assistant', 'done']]);
    assert.equal(restored.messages.some((message) => /CUPPET_CONTEXT/.test(message.content)), false);
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});

test('orchestrator mode bypasses automatic retrieval and plan/build mode persists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-b1-orch-')); const events = []; const providerRequests = [];
  const tst = { configured: true, status: { configured: true }, prepareContext: async () => ({ observation_complete: true, stm: [{ key: 'x', value: 'y' }] }), turnCompleted: async () => {}, close() {} };
  const runtime = new RuntimeService({ databasePath: join(dir, 'db.sqlite3'), dataDir: dir, emit: (event) => events.push(event), providerFactory: () => ({ async stream(messages, { onDelta }) { providerRequests.push(messages); await onDelta('ok'); } }), tst, backgroundFactory: backgroundStub });
  try {
    const session = await runtime.handle('session.create');
    await runtime.handle('session.mode.set', { sessionId: session.id, mode: 'plan' });
    assert.equal((await runtime.handle('session.mode.get', { sessionId: session.id })).mode, 'plan');
    await runtime.handle('orchestrator.set', { enabled: true });
    await runtime.handle('session.send', { sessionId: session.id, text: 'Orchestrate this', provider: { apiKey: 'x', model: 'm' } });
    await waitFor(events, (event) => event.type === 'run.finished');
    assert.equal(providerRequests[0].some((message) => /CUPPET_(?:PLAN_MODE_)?CONTEXT/.test(message.content)), false);
    assert.equal((await runtime.handle('cognitive.status')).orchestratorEnabled, true);
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});

test('runtime STM compaction is fail-closed when TST is unavailable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-b1-compact-'));
  const runtime = new RuntimeService({ databasePath: join(dir, 'db.sqlite3'), dataDir: dir, tst: { configured: false, status: { configured: false }, close() {} }, backgroundFactory: backgroundStub });
  try {
    const session = await runtime.handle('session.create');
    const result = await runtime.handle('context.compact', { sessionId: session.id, prompt: 'compact' });
    assert.equal(result.abort, true);
    assert.match(result.directive, /preserve the full durable transcript/i);
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});
