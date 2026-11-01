import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeService } from '../src/runtime/service.mjs';
import { executeCommand, parseSlashCommand } from '../src/runtime/commands.mjs';
import { CognitiveStateStore } from '../src/runtime/cognitive-state.mjs';

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

function waitForCount(events, predicate, count, timeout = 1500) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const matches = events.filter(predicate);
      if (matches.length >= count) { clearInterval(timer); resolve(matches); }
      else if (Date.now() - started > timeout) { clearInterval(timer); reject(new Error(`timed out waiting for ${count} events`)); }
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

test('runtime owns TST completion at each terminal run boundary after run.finished', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-b1-terminal-tst-'));
  const events = [];
  const order = [];
  let providerTurns = 0;
  let completions = 0;
  const tst = {
    configured: true,
    status: { configured: true, connected: true, protocol: 'cuppet.tst.v3' },
    async prepareContext() { return { observation_complete: true, stm: [{ key: 'goal', value: 'terminal ownership' }] }; },
    async turnCompleted(sessionId) { completions += 1; order.push(`tst:${sessionId}:${completions}`); return { promoted: 0 }; },
    async refreshStm() { return { records: [] }; },
    close() {},
  };
  const runtime = new RuntimeService({
    databasePath: join(dir, 'db.sqlite3'),
    dataDir: dir,
    emit: (event) => { events.push(event); if (event.type === 'run.finished') order.push(`finished:${event.sessionId}`); },
    providerFactory: () => ({
      async stream(_messages, { onDelta }) {
        providerTurns += 1;
        if (providerTurns === 2) throw new Error('synthetic provider failure');
        await onDelta('ok');
        return { text: 'ok' };
      },
    }),
    tst,
    backgroundFactory: backgroundStub,
  });
  try {
    const session = await runtime.handle('session.create');
    await runtime.handle('session.send', { sessionId: session.id, text: 'First turn', provider: { apiKey: 'x', model: 'm' } });
    await waitForCount(events, (event) => event.type === 'run.finished', 1);
    await runtime.handle('session.send', { sessionId: session.id, text: 'Second turn fails', provider: { apiKey: 'x', model: 'm' } });
    await waitForCount(events, (event) => event.type === 'run.finished', 2);
    await waitForCount(order, (entry) => entry.startsWith('tst:'), 2);

    assert.equal(completions, 2, 'every terminal generation must complete TST exactly once');
    assert.deepEqual(order, [
      `finished:${session.id}`, `tst:${session.id}:1`,
      `finished:${session.id}`, `tst:${session.id}:2`,
    ]);
    const restored = await runtime.handle('session.get', { sessionId: session.id });
    assert.deepEqual(restored.messages.filter((message) => message.role === 'assistant').map((message) => message.status), ['complete', 'error']);
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});

test('TST completion failure is nonfatal and cannot suppress run.finished', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-b1-terminal-tst-fail-'));
  const events = [];
  let attempts = 0;
  const tst = {
    configured: true,
    status: { configured: true, connected: false, protocol: 'cuppet.tst.v3' },
    async prepareContext() { throw new Error('TST unavailable'); },
    async turnCompleted() { attempts += 1; throw new Error('TST completion unavailable'); },
    close() {},
  };
  const runtime = new RuntimeService({
    databasePath: join(dir, 'db.sqlite3'), dataDir: dir, emit: (event) => events.push(event), tst,
    providerFactory: () => ({ async stream(_messages, { onDelta }) { await onDelta('still completes'); } }),
    backgroundFactory: backgroundStub,
  });
  try {
    const session = await runtime.handle('session.create');
    await runtime.handle('session.send', { sessionId: session.id, text: 'Keep TST failure nonfatal', provider: { apiKey: 'x', model: 'm' } });
    await waitFor(events, (event) => event.type === 'run.finished');
    assert.equal(attempts, 1);
    const restored = await runtime.handle('session.get', { sessionId: session.id });
    assert.equal(restored.messages.at(-1)?.status, 'complete');
    assert.equal(restored.messages.at(-1)?.content, 'still completes');
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

test('slash compaction persists across restart and changes model context while preserving chat history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-slash-compact-'));
  const events = [], requests = [];
  let records = [{ key: 'goal', value: 'Keep the retained requirement' }];
  const tst = { configured: true, status: { configured: true }, close() {},
    prepareContext: async () => ({}), refreshStm: async () => ({ records }),
    queryMemory: async () => ({ records }), turnCompleted: async () => ({}) };
  const options = { databasePath: join(dir, 'db.sqlite3'), dataDir: dir, tst,
    emit: event => events.push(event), backgroundFactory: backgroundStub,
    providerFactory: () => ({ async stream(messages, { onDelta }) { requests.push(messages); await onDelta('done'); return { text: 'done' }; } }) };
  let runtime = new RuntimeService(options);
  const context = { sessionId: null, call: (method, params) => runtime.handle(method, params) };
  try {
    const session = await runtime.handle('session.create');
    context.sessionId = session.id;
    await runtime.handle('session.send', { sessionId: session.id, text: 'Original requirement' });
    await waitFor(events, event => event.type === 'run.finished');
    const before = (await runtime.handle('session.get', { sessionId: session.id })).messages;
    const compact = await executeCommand(parseSlashCommand('/compact'), context);
    assert.equal(compact.error, false);
    assert.equal(compact.result.compacted, true);
    assert.match(compact.presentation, /Context compacted through 2 messages/);
    assert.deepEqual((await runtime.handle('session.get', { sessionId: session.id })).messages, before);
    await runtime.close();
    events.length = 0;
    runtime = new RuntimeService(options);
    await runtime.handle('session.send', { sessionId: session.id, text: 'Continue the task' });
    await waitFor(events, event => event.type === 'run.finished');
    assert.deepEqual(requests.at(-1).filter(message => message.role === 'user').map(message => message.content), ['Continue the task']);
    assert.ok(requests.at(-1).some(message => message.role === 'system' && message.content.includes('Keep the retained requirement')));
    const memory = await executeCommand(parseSlashCommand('/memory goal'), context);
    assert.match(memory.presentation, /goal: Keep the retained requirement/);
    assert.equal((await runtime.handle('session.get', { sessionId: session.id })).messages.length, 4);

    records = [{ key: 'stale', value: 'Old state', stale: true }];
    const failed = await executeCommand(parseSlashCommand('/compact'), context);
    assert.equal(failed.error, true);
    assert.equal(failed.result.abort, true);
    const persisted = new CognitiveStateStore(join(dir, 'cognitive-state.json'));
    await persisted.ready();
    assert.equal(persisted.compaction(session.id).throughSequence, compact.result.throughSequence, 'failed compaction preserves the last valid checkpoint');
    await runtime.handle('session.cleanup', { sessionId: session.id });
    const cleaned = new CognitiveStateStore(join(dir, 'cognitive-state.json'));
    await cleaned.ready();
    assert.equal(cleaned.compaction(session.id), null, 'purge removes the saved compaction');
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});

test('manual compaction rejects a running chat', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-slash-busy-'));
  const events = [];
  const runtime = new RuntimeService({ databasePath: join(dir, 'db.sqlite3'), dataDir: dir,
    emit: event => events.push(event), tst: { configured: false, close() {} }, backgroundFactory: backgroundStub,
    providerFactory: () => ({ async stream(_messages, { signal }) { while (!signal.aborted) await new Promise(resolve => setTimeout(resolve, 5)); } }) });
  try {
    const session = await runtime.handle('session.create');
    await runtime.handle('session.send', { sessionId: session.id, text: 'Keep working' });
    await assert.rejects(runtime.handle('context.compact', { sessionId: session.id }), /while this chat is generating/);
    runtime.stop(session.id);
    await waitFor(events, event => event.type === 'run.finished');
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
