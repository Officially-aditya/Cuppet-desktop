import assert from 'node:assert/strict';
import test from 'node:test';
import { JournaledToolRuntime } from '../src/runtime/journaled-tool-runtime.mjs';
import { ProviderRuntimeManager, acpRuntimeFingerprint, openCodeRuntimeFingerprint } from '../src/runtime/providers/runtime-manager.mjs';

function fakeRuntime(log) {
  return {
    async start() { log.push('start'); },
    async newSession() { log.push('newSession'); },
    async runTurn({ messages }, hooks) {
      log.push(['run', messages.at(-1)?.content]);
      await hooks.onText?.('ok');
      return { text: 'ok', usage: null };
    },
    async cancel() { log.push('cancel'); },
    async close() { log.push('close'); },
  };
}
function managedAdapter(config, backendId = 'opencode') {
  return {
    cuppetManagedRuntime: () => ({
      protocol: 'acp',
      backendId,
      descriptor: { id: backendId, label: backendId, transport: 'acp', command: backendId, args: [], envOverride: '', loginHint: '' },
      configuration: config,
    }),
    stream: async () => ({ text: 'stateless' }),
  };
}
function toolDefinition(name = 'cuppet_plan') {
  return { type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } };
}

test('manager reuses one ACP process per Cuppet session but refreshes ACP logical session per turn', async () => {
  const log = [];
  let constructed = 0;
  const manager = new ProviderRuntimeManager({
    usageRecorder: async () => {},
    acpRuntimeFactory: () => { constructed += 1; return fakeRuntime(log); },
  });
  const adapter = managedAdapter({ providerID: 'opencode', primary: { modelID: 'provider/model-a' } });
  await manager.adapterFor({ sessionId: 'chat-1', adapter, projectRoot: '/tmp/project' }).stream([{ role: 'user', content: 'one' }]);
  await manager.adapterFor({ sessionId: 'chat-1', adapter, projectRoot: '/tmp/project' }).stream([{ role: 'user', content: 'two' }]);
  assert.equal(constructed, 1);
  assert.deepEqual(log.filter((item) => typeof item === 'string'), ['start', 'newSession']);
  assert.equal(manager.size, 1);
  await manager.close();
  assert.equal(log.at(-1), 'close');
});

test('manager replaces ACP runtime when backend, model, or project authority changes', async () => {
  const logs = [];
  const manager = new ProviderRuntimeManager({ usageRecorder: async () => {}, acpRuntimeFactory: () => { const log = []; logs.push(log); return fakeRuntime(log); } });
  await manager.adapterFor({ sessionId: 'chat-1', adapter: managedAdapter({ providerID: 'opencode', primary: { modelID: 'a' } }), projectRoot: '/tmp/a' }).stream([]);
  await manager.adapterFor({ sessionId: 'chat-1', adapter: managedAdapter({ providerID: 'opencode', primary: { modelID: 'b' } }), projectRoot: '/tmp/a' }).stream([]);
  assert.equal(logs.length, 2);
  assert.ok(logs[0].includes('close'));
  await manager.adapterFor({ sessionId: 'chat-1', adapter: managedAdapter({ providerID: 'kiro', primary: { modelID: 'b' } }, 'kiro'), projectRoot: '/tmp/a' }).stream([]);
  assert.equal(logs.length, 3);
  assert.ok(logs[1].includes('close'));
  await manager.adapterFor({ sessionId: 'chat-1', adapter: managedAdapter({ providerID: 'kiro', primary: { modelID: 'b' } }, 'kiro'), projectRoot: '/tmp/b' }).stream([]);
  assert.equal(logs.length, 4);
  assert.ok(logs[2].includes('close'));
  await manager.close();
});

test('manager passes ordinary providers through untouched', () => {
  const adapter = { stream: async () => ({ text: 'fallback' }) };
  const manager = new ProviderRuntimeManager({ acpRuntimeFactory: () => { throw new Error('unexpected'); } });
  assert.equal(manager.adapterFor({ sessionId: 'chat-1', adapter }), adapter);
  assert.equal(manager.size, 0);
});

test('manager evicts idle ACP processes', async () => {
  const log = [];
  const manager = new ProviderRuntimeManager({ idleMs: 15, usageRecorder: async () => {}, acpRuntimeFactory: () => fakeRuntime(log) });
  await manager.adapterFor({ sessionId: 'chat-1', adapter: managedAdapter({ providerID: 'opencode' }) }).stream([]);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(manager.size, 0);
  assert.ok(log.includes('close'));
});

test('aborting a managed ACP turn immediately revokes its Cuppet MCP tool authority', async () => {
  const runtimeLog = [];
  const toolLog = [];
  let finishTurn;
  let signalTurnStarted;
  const turnStarted = new Promise((resolve) => { signalTurnStarted = resolve; });
  const runtime = {
    async start() { runtimeLog.push('start'); },
    async newSession() { runtimeLog.push('newSession'); },
    async runTurn(_input, hooks) {
      runtimeLog.push('run');
      hooks.signal?.addEventListener('abort', () => runtimeLog.push('signal-abort'), { once: true });
      signalTurnStarted();
      return new Promise((resolve) => { finishTurn = resolve; });
    },
    async cancel() { runtimeLog.push('cancel'); },
    async close() { runtimeLog.push('close'); },
  };
  const manager = new ProviderRuntimeManager({
    usageRecorder: async () => {},
    acpRuntimeFactory: () => runtime,
    toolSessionFactory: () => {
      let closed = false;
      return {
        async start() { toolLog.push('start'); },
        setTurn() { toolLog.push('setTurn'); },
        descriptor() { return { name: 'cuppet-runtime', command: process.execPath, args: [], env: [] }; },
        async close() { if (!closed) { closed = true; toolLog.push('close'); } },
      };
    },
  });
  const controller = new AbortController();
  const stream = manager.adapterFor({ sessionId: 'chat-abort', adapter: managedAdapter({ providerID: 'opencode' }) }).stream([], {
    signal: controller.signal,
    tools: [toolDefinition()],
    executeTool: async () => ({ success: true, output: 'unused' }),
  });
  await turnStarted;
  controller.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(runtimeLog.includes('signal-abort'));
  assert.deepEqual(toolLog, ['start', 'setTurn', 'close']);

  finishTurn({ text: '', usage: null });
  await stream;
  await manager.close();
});

test('manager cancel revokes active MCP authority as well as cancelling the provider runtime', async () => {
  const runtimeLog = [];
  const toolLog = [];
  let finishTurn;
  let signalTurnStarted;
  const turnStarted = new Promise((resolve) => { signalTurnStarted = resolve; });
  const runtime = {
    async start() {},
    async newSession() {},
    async runTurn() {
      signalTurnStarted();
      return new Promise((resolve) => { finishTurn = resolve; });
    },
    async cancel() { runtimeLog.push('cancel'); },
    async close() { runtimeLog.push('close'); },
  };
  const manager = new ProviderRuntimeManager({
    usageRecorder: async () => {},
    acpRuntimeFactory: () => runtime,
    toolSessionFactory: () => {
      let closed = false;
      return {
        async start() {},
        setTurn() {},
        descriptor() { return { name: 'cuppet-runtime', command: process.execPath, args: [], env: [] }; },
        async close() { if (!closed) { closed = true; toolLog.push('close'); } },
      };
    },
  });
  const stream = manager.adapterFor({ sessionId: 'chat-cancel', adapter: managedAdapter({ providerID: 'opencode' }) }).stream([], {
    tools: [toolDefinition()],
    executeTool: async () => ({ success: true, output: 'unused' }),
  });
  await turnStarted;
  assert.equal(await manager.cancel('chat-cancel'), true);
  assert.deepEqual(runtimeLog, ['cancel']);
  assert.deepEqual(toolLog, ['close']);
  finishTurn({ text: '', usage: null });
  await stream;
  await manager.close();
});

test('ACP runtime fingerprint is stable and sensitive to backend execution authority', () => {
  const descriptor = { id: 'opencode', command: 'opencode', args: ['acp'] };
  const one = acpRuntimeFingerprint({ backendId: 'opencode', descriptor, configuration: { providerID: 'opencode', primary: { modelID: 'a' }, primaryEffort: 'high' }, projectRoot: '/tmp/project' });
  const same = acpRuntimeFingerprint({ backendId: 'opencode', descriptor, configuration: { primaryEffort: 'high', primary: { modelID: 'a' }, providerID: 'opencode' }, projectRoot: '/tmp/project' });
  const modelChanged = acpRuntimeFingerprint({ backendId: 'opencode', descriptor, configuration: { providerID: 'opencode', primary: { modelID: 'b' }, primaryEffort: 'high' }, projectRoot: '/tmp/project' });
  const backendChanged = acpRuntimeFingerprint({ backendId: 'kiro', descriptor: { id: 'kiro', command: 'kiro-cli', args: ['acp'] }, configuration: { providerID: 'kiro', primary: { modelID: 'a' }, primaryEffort: 'high' }, projectRoot: '/tmp/project' });
  assert.equal(one, same);
  assert.notEqual(one, modelChanged);
  assert.notEqual(one, backendChanged);
  assert.equal(openCodeRuntimeFingerprint({ providerID: 'opencode', primary: { modelID: 'a' }, primaryEffort: 'high' }, '/tmp/project'), one);
});

test('JournaledToolRuntime binds adapters through the session-aware runtime manager', async () => {
  const bound = [];
  const adapter = {
    async stream(_messages, options) {
      options.onDelta('Final.');
      return { text: 'Final.', toolCalls: [] };
    },
  };
  const providerRuntimeManager = {
    adapterFor(input) { bound.push(input); return input.adapter; },
  };
  const runtime = new JournaledToolRuntime({
    journal: null,
    db: {
      getSession: () => ({ messages: [{ id: 'assistant-1', role: 'assistant', status: 'streaming', content: '' }] }),
      createToolExecution: () => ({}),
      finishToolExecution: () => ({}),
    },
    providerRuntimeManager,
    tst: { configured: false },
    planStore: { toolResult: async () => 'plan' },
    permissions: { authorize: async () => ({ source: 'test' }) },
    questions: null,
  });
  const final = [];
  await runtime.run({
    adapter,
    messages: [{ role: 'user', content: 'work' }],
    sessionId: 'session-1',
    projectRoot: '/tmp/project',
    onDelta: async (value) => final.push(value),
  });
  assert.equal(bound.length, 1);
  assert.equal(bound[0].sessionId, 'session-1');
  assert.equal(bound[0].projectRoot, '/tmp/project');
  assert.equal(bound[0].adapter, adapter);
  assert.deepEqual(final, ['Final.']);
});
