import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexSessionRuntime, CodexSubscriptionProvider } from '../src/runtime/codex-provider.mjs';

class FakeCodexClient extends EventEmitter {
  constructor({ account = { type: 'chatgpt', planType: 'plus' }, toolCall = true } = {}) {
    super();
    this.account = account;
    this.toolCall = toolCall;
    this.requests = [];
    this.responses = [];
    this.startedTurn = deferred();
    this.startCount = 0;
    this.closeCount = 0;
    this.closed = false;
  }
  async start() { this.startCount += 1; return this; }
  async close() { this.closeCount += 1; this.closed = true; }
  async request(method, params = {}) {
    this.requests.push({ method, params });
    if (method === 'account/read') return { account: this.account, requiresOpenaiAuth: true };
    if (method === 'thread/start') { this.threadParams = params; return { thread: { id: 'thread-1' } }; }
    if (method === 'turn/start') {
      this.startedTurn.resolve(params);
      queueMicrotask(() => {
        if (this.toolCall) this.emit('request', { id: 500, method: 'item/tool/call', params: { callId: 'call-1', turnId: 'turn-1', tool: 'echo_tool', arguments: { value: 'hello' } } });
        else this.finish();
      });
      return { turn: { id: 'turn-1' } };
    }
    if (method === 'turn/interrupt') {
      queueMicrotask(() => this.emit('notification', { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } } }));
      return {};
    }
    return {};
  }
  respond(id, result) {
    this.responses.push({ id, result });
    if (id === 500) queueMicrotask(() => this.finish());
  }
  respondError(id, message, code) { this.responses.push({ id, error: { message, code } }); }
  finish() {
    this.emit('notification', { method: 'item/agentMessage/delta', params: { delta: 'done' } });
    this.emit('notification', {
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage: {
          total: {
            inputTokens: 24,
            cachedInputTokens: 10,
            outputTokens: 7,
            reasoningOutputTokens: 2,
            totalTokens: 31,
          },
          last: {
            inputTokens: 5,
            cachedInputTokens: 3,
            outputTokens: 2,
            reasoningOutputTokens: 1,
            totalTokens: 7,
          },
          modelContextWindow: 258400,
        },
      },
    });
    this.emit('notification', { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
  }
}

test('subscription provider streams through Codex while Cuppet executes dynamic tools', async () => {
  const client = new FakeCodexClient();
  const provider = new CodexSubscriptionProvider({
    providerID: 'codex',
    model: 'codex-default',
    primaryEffort: 'high',
    codexLaunch: { command: 'fake', args: [], source: 'test' },
    clientFactory: () => client,
  });
  const deltas = [];
  const activities = [];
  const toolCalls = [];
  const result = await provider.stream([{ role: 'user', content: 'Use the tool.' }], {
    onDelta: (delta) => deltas.push(delta),
    onActivity: (activity) => activities.push(activity),
    tools: [{ type: 'function', function: { name: 'echo_tool', description: 'Echo', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } } }],
    executeTool: async (call) => { toolCalls.push(call); return { output: 'tool-ok', success: true, paths: [], mutation: false }; },
  });

  assert.equal(result.text, 'done');
  assert.deepEqual(deltas, ['done']);
  assert.equal(result.usage.totalTokens, 31);
  assert.equal(result.usage.inputTokens, 24);
  assert.equal(result.usage.outputTokens, 7);
  assert.equal(result.usage.cachedInputTokens, 10);
  assert.equal(result.usage.reasoningTokens, 2);
  assert.deepEqual(activities.map((activity) => activity.type), [
    'activity.status',
    'activity.text.delta',
    'activity.usage',
    'activity.status',
  ]);
  assert.equal(activities[0].status, 'running');
  assert.equal(activities[1].text, 'done');
  assert.equal(activities[2].usage.totalTokens, 31);
  assert.deepEqual(activities[2].contextUsage, { usedTokens: 7, windowTokens: 258400 });
  assert.equal(activities[3].status, 'completed');
  assert.ok(!activities.some((activity) => activity.type.startsWith('activity.tool.')), 'provider transport must not duplicate ToolRuntime execution cards');
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].name, 'echo_tool');
  assert.deepEqual(JSON.parse(toolCalls[0].arguments), { value: 'hello' });
  assert.equal(client.responses[0].result.success, true);
  assert.equal(client.responses[0].result.contentItems[0].text, 'tool-ok');
  assert.equal(client.threadParams.ephemeral, true);
  assert.equal(client.threadParams.sandbox, 'read-only');
  assert.equal(client.threadParams.approvalPolicy, 'never');
  assert.deepEqual(client.threadParams.config, { model_reasoning_effort: 'high' });
  assert.equal(client.threadParams.dynamicTools[0].type, 'function');
  assert.equal(client.threadParams.dynamicTools[0].inputSchema.type, 'object');
  assert.match(client.threadParams.cwd, /cuppet-codex-runtime/);
  assert.equal(client.closed, true);
});

test('managed Codex runtime reuses one app-server while model and effort change per ephemeral thread', async () => {
  const client = new FakeCodexClient({ toolCall: false });
  const runtime = new CodexSessionRuntime({
    configuration: {
      codexLaunch: { command: 'fake', args: [], source: 'test' },
      clientFactory: () => client,
    },
  });
  try {
    await runtime.start();
    const first = await runtime.runTurn({
      messages: [{ role: 'user', content: 'first' }],
      selection: { model: 'gpt-first', effort: 'high' },
    });
    const second = await runtime.runTurn({
      messages: [{ role: 'user', content: 'second' }],
      selection: { model: 'gpt-second', effort: 'low' },
    });
    assert.equal(first.text, 'done');
    assert.equal(second.text, 'done');
    assert.equal(client.startCount, 1);
    assert.equal(client.closeCount, 0);
    const threadStarts = client.requests.filter((request) => request.method === 'thread/start');
    assert.equal(threadStarts.length, 2);
    assert.equal(threadStarts[0].params.model, 'gpt-first');
    assert.deepEqual(threadStarts[0].params.config, { model_reasoning_effort: 'high' });
    assert.equal(threadStarts[1].params.model, 'gpt-second');
    assert.deepEqual(threadStarts[1].params.config, { model_reasoning_effort: 'low' });
    assert.equal(threadStarts[0].params.ephemeral, true);
    assert.equal(threadStarts[1].params.ephemeral, true);
  } finally {
    await runtime.close();
  }
  assert.equal(client.closeCount, 1);
});

test('Codex provider exposes managed app-server runtime metadata without changing stateless fallback', () => {
  const provider = new CodexSubscriptionProvider({ providerID: 'codex', model: 'gpt-test' });
  const managed = provider.cuppetManagedRuntime();
  assert.equal(managed.protocol, 'codex-app-server');
  assert.equal(managed.backendId, 'codex');
  assert.equal(managed.configuration.model, 'gpt-test');
});

test('Codex Activity and text observers cannot fail a successful turn', async () => {
  const client = new FakeCodexClient({ toolCall: false });
  const provider = new CodexSubscriptionProvider({ codexLaunch: { command: 'fake', args: [], source: 'test' }, clientFactory: () => client });
  const result = await provider.stream([{ role: 'user', content: 'hello' }], {
    onDelta: async () => { throw new Error('renderer text observer failed'); },
    onActivity: async () => { throw new Error('renderer activity observer failed'); },
  });
  assert.equal(result.text, 'done');
  assert.equal(result.usage.totalTokens, 31);
  assert.equal(client.closed, true);
});

test('subscription provider interrupts the Codex turn on abort', async () => {
  const client = new FakeCodexClient({ toolCall: false });
  client.finish = () => {};
  const provider = new CodexSubscriptionProvider({ codexLaunch: { command: 'fake', args: [], source: 'test' }, clientFactory: () => client });
  const controller = new AbortController();
  const running = provider.stream([{ role: 'user', content: 'Keep working.' }], { signal: controller.signal });
  await client.startedTurn.promise;
  await new Promise(setImmediate);
  controller.abort();
  await assert.rejects(running, (error) => error?.name === 'AbortError');
  assert.ok(client.requests.some((request) => request.method === 'turn/interrupt'));
  assert.equal(client.closed, true);
});

test('Codex abort completes and retires the process when interrupt fails or never completes', async () => {
  for (const mode of ['failure', 'acknowledged', 'unresponsive']) {
    const client = new FakeCodexClient({ toolCall: false });
    client.finish = () => {};
    const request = client.request.bind(client);
    client.request = (method, params) => {
      if (method !== 'turn/interrupt') return request(method, params);
      if (mode === 'failure') return Promise.reject(new Error('interrupt failed'));
      if (mode === 'unresponsive') return new Promise(() => {});
      return Promise.resolve({});
    };
    const runtime = new CodexSessionRuntime({ configuration: { codexLaunch: { command: 'fake' }, clientFactory: () => client } });
    const controller = new AbortController();
    try {
      const running = runtime.runTurn({ messages: [] }, { signal: controller.signal });
      await client.startedTurn.promise;
      await new Promise(setImmediate);
      const rejected = assert.rejects(running, (error) => error.name === 'AbortError');
      controller.abort();
      await rejected;
      assert.deepEqual(runtime.snapshot(), { state: 'idle', active: false }, mode);
      assert.equal(client.closeCount, 1, mode);
    } finally { await runtime.close(); }
  }
});

test('Codex can abort while thread/start or turn/start is still waiting', async () => {
  for (const pendingMethod of ['thread/start', 'turn/start']) {
    const client = new FakeCodexClient({ toolCall: false });
    const waiting = deferred();
    const response = deferred();
    const request = client.request.bind(client);
    client.request = (method, params) => {
      if (method !== pendingMethod) return request(method, params);
      waiting.resolve();
      return response.promise;
    };
    const runtime = new CodexSessionRuntime({ configuration: { codexLaunch: { command: 'fake' }, clientFactory: () => client } });
    const controller = new AbortController();
    try {
      const running = runtime.runTurn({ messages: [] }, { signal: controller.signal });
      await waiting.promise;
      const rejected = assert.rejects(running, (error) => error.name === 'AbortError');
      controller.abort();
      await rejected;
      assert.equal(client.closed, true);
      response.resolve(pendingMethod === 'thread/start' ? { thread: { id: 'late-thread' } } : { turn: { id: 'late-turn' } });
      await new Promise(setImmediate);
      assert.equal(runtime.snapshot().active, false);
      if (pendingMethod === 'thread/start') assert.equal(client.requests.some(({ method }) => method === 'turn/start'), false);
    } finally { await runtime.close(); }
  }
});

test('Codex rejects a pre-aborted turn without starting a process', async () => {
  const client = new FakeCodexClient();
  const runtime = new CodexSessionRuntime({ configuration: { codexLaunch: { command: 'fake' }, clientFactory: () => client } });
  await assert.rejects(runtime.runTurn({}, { signal: AbortSignal.abort() }), (error) => error.name === 'AbortError');
  assert.equal(client.startCount, 0);
  await runtime.close();
});

test('Codex discards text from another thread or turn', async () => {
  const client = new FakeCodexClient({ toolCall: false });
  client.finish = () => {};
  const runtime = new CodexSessionRuntime({ configuration: { codexLaunch: { command: 'fake' }, clientFactory: () => client } });
  const deltas = [];
  try {
    const running = runtime.runTurn({}, { onDelta: (delta) => deltas.push(delta) });
    await client.startedTurn.promise;
    await new Promise(setImmediate);
    for (const [threadId, turnId] of [['old-thread', 'turn-1'], ['thread-1', 'old-turn'], ['thread-1', 'turn-1']]) {
      client.emit('notification', { method: 'item/agentMessage/delta', params: { threadId, turnId, delta: 'valid' } });
    }
    client.emit('notification', { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    assert.equal((await running).text, 'valid');
    assert.deepEqual(deltas, ['valid']);
  } finally { await runtime.close(); }
});

test('Codex ignores old notifications during thread creation and preserves early turn/start deltas', async () => {
  const client = new FakeCodexClient({ toolCall: false });
  const request = client.request.bind(client);
  client.request = (method, params) => {
    if (method === 'thread/start') {
      client.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: 'old-thread', turnId: 'old-turn', delta: 'stale' } });
      client.emit('notification', { method: 'turn/completed', params: { threadId: 'old-thread', turn: { id: 'old-turn', status: 'failed' } } });
    }
    if (method === 'turn/start') {
      client.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'early ' } });
    }
    return request(method, params);
  };
  const runtime = new CodexSessionRuntime({ configuration: { codexLaunch: { command: 'fake' }, clientFactory: () => client } });
  try {
    assert.equal((await runtime.runTurn({})).text, 'early done');
  } finally { await runtime.close(); }
});

test('a cancelled Codex client cannot emit into the next turn or reset its runtime', async () => {
  const clients = [new FakeCodexClient({ toolCall: false }), new FakeCodexClient({ toolCall: false })];
  for (const client of clients) client.finish = () => {};
  let next = 0;
  const runtime = new CodexSessionRuntime({ configuration: { codexLaunch: { command: 'fake' }, clientFactory: () => clients[next++] } });
  const controller = new AbortController();
  try {
    const first = runtime.runTurn({}, { signal: controller.signal });
    await clients[0].startedTurn.promise;
    const rejected = assert.rejects(first, (error) => error.name === 'AbortError');
    controller.abort();
    await rejected;
    const second = runtime.runTurn({});
    await clients[1].startedTurn.promise;
    await new Promise(setImmediate);
    clients[0].emit('notification', { method: 'item/agentMessage/delta', params: { delta: 'stale' } });
    clients[0].emit('exit', { code: 0 });
    assert.equal(runtime.snapshot().state, 'running');
    FakeCodexClient.prototype.finish.call(clients[1]);
    assert.equal((await second).text, 'done');
    assert.equal(next, 2);
  } finally { await runtime.close(); }
});

test('subscription provider refuses API-key Codex auth', async () => {
  const client = new FakeCodexClient({ account: { type: 'apiKey' }, toolCall: false });
  const provider = new CodexSubscriptionProvider({ codexLaunch: { command: 'fake', args: [], source: 'test' }, clientFactory: () => client });
  await assert.rejects(provider.stream([{ role: 'user', content: 'hello' }]), /Connect your ChatGPT account/);
});

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}
