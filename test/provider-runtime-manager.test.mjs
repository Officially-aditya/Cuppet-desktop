import assert from 'node:assert/strict';
import test from 'node:test';
import { JournaledToolRuntime } from '../src/runtime/journaled-tool-runtime.mjs';
import { ProviderRuntimeManager, acpRuntimeFingerprint, acpSessionSelection } from '../src/runtime/providers/runtime-manager.mjs';

function fakeRuntime(log) {
  return {
    async start(options = {}) { log.push('start', ['selection', 'start', options.selection]); },
    async newSession(options = {}) { log.push('newSession', ['selection', 'newSession', options.selection]); },
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
      descriptor: { id: backendId, label: backendId, transport: 'acp', command: backendId, args: [], envOverride: '', loginHint: '', mcpToolBridge: true },
      configuration: config,
    }),
    stream: async () => ({ text: 'stateless' }),
  };
}
function toolDefinition(name = 'cuppet_plan') {
  return { type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } };
}

test('manager reuses one ACP process while applying model and effort to each logical session', async () => {
  const log = [];
  let constructed = 0;
  const manager = new ProviderRuntimeManager({
    usageRecorder: async () => {},
    acpRuntimeFactory: () => { constructed += 1; return fakeRuntime(log); },
  });
  const first = managedAdapter({ providerID: 'opencode', primary: { modelID: 'provider/model-a', variant: 'high' } });
  const second = managedAdapter({ providerID: 'opencode', primary: { modelID: 'provider/model-b', variant: 'max' } });
  await manager.adapterFor({ sessionId: 'chat-1', adapter: first, projectRoot: '/tmp/project' }).stream([{ role: 'user', content: 'one' }]);
  await manager.adapterFor({ sessionId: 'chat-1', adapter: second, projectRoot: '/tmp/project' }).stream([{ role: 'user', content: 'two' }]);
  assert.equal(constructed, 1);
  assert.deepEqual(log.filter((item) => typeof item === 'string'), ['start', 'newSession']);
  assert.deepEqual(log.filter((item) => Array.isArray(item) && item[0] === 'selection'), [
    ['selection', 'start', { model: 'provider/model-a', effort: 'high' }],
    ['selection', 'newSession', { model: 'provider/model-b', effort: 'max' }],
  ]);
  assert.equal(manager.size, 1);
  await manager.close();
  assert.equal(log.at(-1), 'close');
});

test('manager keeps different ACP providers warm and reuses them when switching back', async () => {
  const logs = [];
  const manager = new ProviderRuntimeManager({ usageRecorder: async () => {}, acpRuntimeFactory: ({ backendId }) => { const log = [backendId]; logs.push(log); return fakeRuntime(log); } });
  await manager.adapterFor({ sessionId: 'chat-1', adapter: managedAdapter({ providerID: 'opencode', primary: { modelID: 'a' } }), projectRoot: '/tmp/a' }).stream([]);
  await manager.adapterFor({ sessionId: 'chat-1', adapter: managedAdapter({ providerID: 'opencode', primary: { modelID: 'b' } }), projectRoot: '/tmp/a' }).stream([]);
  assert.equal(logs.length, 1);
  assert.ok(!logs[0].includes('close'));

  await manager.adapterFor({ sessionId: 'chat-1', adapter: managedAdapter({ providerID: 'kiro', primary: { modelID: 'b' } }, 'kiro'), projectRoot: '/tmp/a' }).stream([]);
  assert.equal(logs.length, 2);
  assert.equal(manager.size, 2);
  assert.ok(!logs[0].includes('close'));

  await manager.adapterFor({ sessionId: 'chat-1', adapter: managedAdapter({ providerID: 'opencode', primary: { modelID: 'c' } }), projectRoot: '/tmp/a' }).stream([]);
  assert.equal(logs.length, 2);
  assert.deepEqual(logs[0].filter((item) => typeof item === 'string'), ['opencode', 'start', 'newSession', 'newSession']);
  assert.ok(!logs[1].includes('close'));

  await manager.adapterFor({ sessionId: 'chat-1', adapter: managedAdapter({ providerID: 'kiro', primary: { modelID: 'b' } }, 'kiro'), projectRoot: '/tmp/b' }).stream([]);
  assert.equal(logs.length, 3);
  assert.ok(logs[0].includes('close'));
  assert.ok(logs[1].includes('close'));
  assert.equal(manager.size, 1);
  await manager.close();
});

test('manager bounds warm provider processes with least-recently-used eviction', async () => {
  const logs = new Map();
  const manager = new ProviderRuntimeManager({
    maxWarmRuntimes: 2,
    usageRecorder: async () => {},
    acpRuntimeFactory: ({ backendId }) => {
      const log = [];
      logs.set(backendId, log);
      return fakeRuntime(log);
    },
  });
  await manager.adapterFor({ sessionId: 'chat-lru', adapter: managedAdapter({ providerID: 'opencode' }), projectRoot: '/tmp/a' }).stream([]);
  await manager.adapterFor({ sessionId: 'chat-lru', adapter: managedAdapter({ providerID: 'kiro' }, 'kiro'), projectRoot: '/tmp/a' }).stream([]);
  await manager.adapterFor({ sessionId: 'chat-lru', adapter: managedAdapter({ providerID: 'opencode' }), projectRoot: '/tmp/a' }).stream([]);
  await manager.adapterFor({ sessionId: 'chat-lru', adapter: managedAdapter({ providerID: 'github-copilot' }, 'github-copilot'), projectRoot: '/tmp/a' }).stream([]);
  assert.equal(manager.size, 2);
  assert.ok(logs.get('kiro').includes('close'));
  assert.ok(!logs.get('opencode').includes('close'));
  assert.ok(!logs.get('github-copilot').includes('close'));
  await manager.close();
});

test('manager restarts when an explicit ACP selection is cleared back to provider defaults', async () => {
  const logs = [];
  const manager = new ProviderRuntimeManager({ usageRecorder: async () => {}, acpRuntimeFactory: () => { const log = []; logs.push(log); return fakeRuntime(log); } });
  await manager.adapterFor({
    sessionId: 'chat-default-reset',
    adapter: managedAdapter({ providerID: 'opencode', primary: { modelID: 'provider/model-a', variant: 'high' } }),
    projectRoot: '/tmp/a',
  }).stream([]);
  await manager.adapterFor({
    sessionId: 'chat-default-reset',
    adapter: managedAdapter({ providerID: 'opencode', primary: { modelID: 'cli-default' } }),
    projectRoot: '/tmp/a',
  }).stream([]);
  assert.equal(logs.length, 2);
  assert.ok(logs[0].includes('close'));
  assert.deepEqual(logs[1].find((item) => Array.isArray(item) && item[0] === 'selection'), ['selection', 'start', { model: 'cli-default', effort: null }]);
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

test('ACP runtime fingerprint tracks process authority while session selection tracks model intent', () => {
  const descriptor = { id: 'kiro', command: 'kiro-cli', args: ['acp'], mcpToolBridge: false };
  const one = acpRuntimeFingerprint({ backendId: 'kiro', descriptor, configuration: { providerID: 'kiro', primary: { modelID: 'a' }, primaryEffort: 'high' }, projectRoot: '/tmp/project' });
  const same = acpRuntimeFingerprint({ backendId: 'kiro', descriptor, configuration: { primaryEffort: 'high', primary: { modelID: 'a' }, providerID: 'kiro' }, projectRoot: '/tmp/project' });
  const modelChanged = acpRuntimeFingerprint({ backendId: 'kiro', descriptor, configuration: { providerID: 'kiro', primary: { modelID: 'b' }, primaryEffort: 'high' }, projectRoot: '/tmp/project' });
  const effortChanged = acpRuntimeFingerprint({ backendId: 'kiro', descriptor, configuration: { providerID: 'kiro', primary: { modelID: 'a' }, primaryEffort: 'low' }, projectRoot: '/tmp/project' });
  const backendChanged = acpRuntimeFingerprint({ backendId: 'github-copilot', descriptor: { id: 'github-copilot', command: 'copilot', args: ['--acp'], mcpToolBridge: false }, configuration: { providerID: 'github-copilot', primary: { modelID: 'a' }, primaryEffort: 'high' }, projectRoot: '/tmp/project' });
  const mcpChanged = acpRuntimeFingerprint({ backendId: 'kiro', descriptor: { ...descriptor, mcpToolBridge: true }, configuration: { providerID: 'kiro', primary: { modelID: 'a' }, primaryEffort: 'high' }, projectRoot: '/tmp/project' });
  const envChanged = acpRuntimeFingerprint({ backendId: 'kiro', descriptor, configuration: { providerID: 'kiro', primary: { modelID: 'a' }, primaryEffort: 'high', cliEnv: { TEST_MODE: '1' } }, projectRoot: '/tmp/project' });
  assert.equal(one, same);
  assert.equal(one, modelChanged);
  assert.equal(one, effortChanged);
  assert.notEqual(one, backendChanged);
  assert.notEqual(one, mcpChanged);
  assert.notEqual(one, envChanged);
  assert.deepEqual(acpSessionSelection({ primary: { modelID: 'b', variant: 'max' } }), { model: 'b', effort: 'max' });
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
