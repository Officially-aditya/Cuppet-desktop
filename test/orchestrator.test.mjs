import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { RuntimeService } from '../src/runtime/service.mjs';
import { localCliDescriptor } from '../src/runtime/local-cli-descriptors.mjs';
import { AcpProviderAdapter } from '../src/runtime/providers/backends/acp.mjs';
import { antigravityAcpDescriptor, antigravityWorkerConfiguration } from '../src/runtime/providers/backends/antigravity.mjs';
import { AcpSessionRuntime } from '../src/runtime/providers/transports/acp/acp-session.mjs';
import { ProviderRuntimeManager } from '../src/runtime/providers/runtime-manager.mjs';
import { CodexSubscriptionProvider } from '../src/runtime/codex-provider.mjs';
import { createUntrackedChatProvider } from '../src/runtime/provider-factory.mjs';

function waitFor(events, predicate, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const found = events.find(predicate);
      if (found) { clearInterval(timer); resolve(found); }
      else if (Date.now() - started > timeout) { clearInterval(timer); reject(new Error('timed out waiting for runtime event')); }
    }, 5);
  });
}

function backgroundStub() {
  return { stats: {}, async ready() {}, pause() {}, resume() {}, foregroundStarted() {}, foregroundIdle() {}, setProviderConfig() {}, async recordTurn() {}, async close() {} };
}

test('Antigravity workers reuse provider authentication without loading global MCP configuration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-orchestrator-antigravity-'));
  try {
    const sourceHome = join(dir, 'provider-home');
    await mkdir(join(sourceHome, 'antigravity-acp'), { recursive: true });
    await mkdir(join(sourceHome, 'config'));
    await writeFile(join(sourceHome, 'config', 'mcp_config.json'), '{"mcpServers":{"fixed-port":{}}}');
    const configuration = { providerID: 'antigravity', cliEnv: { GEMINI_HOME: sourceHome } };
    const first = await antigravityWorkerConfiguration(configuration, join(dir, 'runtime'));
    const second = await antigravityWorkerConfiguration(configuration, join(dir, 'runtime'));
    assert.equal(first.cliEnv.GEMINI_HOME, second.cliEnv.GEMINI_HOME);
    assert.equal(await realpath(join(first.cliEnv.GEMINI_HOME, 'antigravity-acp')), await realpath(join(sourceHome, 'antigravity-acp')));
    await assert.rejects(() => readFile(join(first.cliEnv.GEMINI_HOME, 'config', 'mcp_config.json')), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('orchestration runs independent workers concurrently on the secondary model and returns their results', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-orchestrator-'));
  const events = [];
  const seenModels = [];
  let active = 0;
  let maxActive = 0;
  let delegateResult;
  const providerFactory = (configuration) => ({
    async stream(messages, { onDelta, tools = [] }) {
      if (messages.some((message) => /Create a concise chat title/.test(message.content || ''))) {
        await onDelta('Delegation test');
        return { text: 'Delegation test' };
      }
      if (messages.some((message) => /You are a Cuppet subagent/.test(message.content || ''))) {
        seenModels.push(configuration.modelID || configuration.primary?.modelID || configuration.model);
        assert.equal(tools.some((item) => item.function?.name === 'cuppet_delegate'), false);
        active += 1; maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 25));
        active -= 1;
        const result = messages.at(-1).content.includes('first task') ? 'first result' : 'second result';
        await onDelta(result);
        return { text: result };
      }
      const reply = messages.find((message) => message.role === 'tool' && message.name === 'cuppet_delegate');
      if (reply) {
        delegateResult = JSON.parse(reply.content);
        await onDelta('Combined worker results.');
        return { text: 'Combined worker results.' };
      }
      assert.ok(tools.some((item) => item.function?.name === 'cuppet_delegate'));
      return { text: '', toolCalls: [{ id: 'delegate-1', name: 'cuppet_delegate', arguments: JSON.stringify({ tasks: [{ name: 'One', task: 'first task' }, { name: 'Two', task: 'second task' }] }) }] };
    },
  });
  const runtime = new RuntimeService({ databasePath: join(dir, 'db.sqlite3'), dataDir: dir, emit: (event) => events.push(event), providerFactory, tst: { configured: false, status: { configured: false }, close() {} }, backgroundFactory: backgroundStub });
  try {
    const session = await runtime.handle('session.create');
    await runtime.handle('orchestrator.set', { enabled: true });
    await runtime.handle('session.send', { sessionId: session.id, text: 'Delegate the independent tasks', provider: { providerID: 'openai-compatible', apiKey: 'test', model: 'primary', backgroundModel: 'secondary' } });
    await waitFor(events, (event) => event.type === 'run.finished');
    assert.equal(maxActive, 2);
    assert.deepEqual(seenModels, ['secondary', 'secondary']);
    assert.deepEqual(delegateResult.workers.map((worker) => [worker.status, worker.result]), [['completed', 'first result'], ['completed', 'second result']]);
    assert.equal(events.filter((event) => event.type === 'runtime.activity' && event.activity?.tool === 'cuppet_subagent' && event.activity.type === 'activity.tool.opened').length, 2);
    const restored = await runtime.handle('session.get', { sessionId: session.id });
    assert.equal(restored.messages.at(-1).content, 'Combined worker results.');
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});

for (const { label, secondary, expectedError } of [
  { label: 'model', secondary: { modelID: 'secondary', enabled: false }, expectedError: /secondary model is unavailable/ },
  { label: 'reasoning effort', secondary: { modelID: 'secondary', variant: 'unavailable' }, expectedError: /secondary reasoning effort is unavailable/ },
]) {
  test(`delegation reports an unavailable secondary ${label} instead of using a fallback`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cuppet-orchestrator-selection-'));
    const events = [];
    let workersStarted = 0;
    let toolReply = '';
    const providerFactory = () => ({
      async stream(messages, { onDelta }) {
        if (messages.some((message) => /Create a concise chat title/.test(message.content || ''))) return { text: 'Title' };
        if (messages.some((message) => /You are a Cuppet subagent/.test(message.content || ''))) { workersStarted += 1; return { text: 'Unexpected worker' }; }
        const reply = messages.find((message) => message.role === 'tool' && message.name === 'cuppet_delegate');
        if (reply) { toolReply = reply.content; await onDelta('Unable to delegate.'); return { text: 'Unable to delegate.' }; }
        return { toolCalls: [{ id: 'delegate-selection', name: 'cuppet_delegate', arguments: JSON.stringify({ tasks: ['Inspect this task'] }) }] };
      },
    });
    const runtime = new RuntimeService({ databasePath: join(dir, 'db.sqlite3'), dataDir: dir, emit: (event) => events.push(event), providerFactory, tst: { configured: false, status: { configured: false }, close() {} }, backgroundFactory: backgroundStub });
    try {
      const session = await runtime.handle('session.create');
      await runtime.handle('orchestrator.set', { enabled: true });
      const capabilities = { tools: true, streaming: true, input: ['text'], output: ['text'] };
      await runtime.handle('session.send', { sessionId: session.id, text: 'Run a worker', provider: {
        providerID: 'openai-compatible', apiKey: 'test', model: 'primary', backgroundModel: 'secondary',
        secondary: { providerID: 'openai-compatible', modelID: secondary.modelID, ...(secondary.variant ? { variant: secondary.variant } : {}) },
        models: [
          { providerID: 'openai-compatible', modelID: 'primary', capabilities },
          { providerID: 'openai-compatible', modelID: 'secondary', enabled: secondary.enabled, capabilities },
        ],
      } });
      await waitFor(events, (event) => event.type === 'run.finished');
      assert.equal(workersStarted, 0);
      assert.match(toolReply, expectedError);
    } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
  });
}

test('stopping an orchestrated turn cancels every running worker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-orchestrator-stop-'));
  const events = [];
  let started = 0;
  let cancelled = 0;
  const providerFactory = () => ({
    async stream(messages, { onDelta, signal }) {
      if (messages.some((message) => /Create a concise chat title/.test(message.content || ''))) return { text: 'Test' };
      if (messages.some((message) => /You are a Cuppet subagent/.test(message.content || ''))) {
        started += 1;
        await new Promise((resolve, reject) => {
          if (signal.aborted) { cancelled += 1; reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })); return; }
          signal.addEventListener('abort', () => { cancelled += 1; reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })); }, { once: true });
        });
        return { text: '' };
      }
      return { text: '', toolCalls: [{ id: 'delegate-stop', name: 'cuppet_delegate', arguments: JSON.stringify({ tasks: [{ name: 'One', task: 'first task' }, { name: 'Two', task: 'second task' }] }) }] };
    },
  });
  const runtime = new RuntimeService({ databasePath: join(dir, 'db.sqlite3'), dataDir: dir, emit: (event) => events.push(event), providerFactory, tst: { configured: false, status: { configured: false }, close() {} }, backgroundFactory: backgroundStub });
  try {
    const session = await runtime.handle('session.create');
    await runtime.handle('orchestrator.set', { enabled: true });
    await runtime.handle('session.send', { sessionId: session.id, text: 'Run workers', provider: { providerID: 'openai-compatible', apiKey: 'test', model: 'primary', backgroundModel: 'secondary' } });
    await waitFor(events, () => started === 2);
    await runtime.handle('session.stop', { sessionId: session.id });
    await waitFor(events, (event) => event.type === 'run.finished');
    assert.equal(cancelled, 2);
    const restored = await runtime.handle('session.get', { sessionId: session.id });
    assert.equal(restored.messages.at(-1).status, 'stopped');
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});

test('provider MCP startup errors are returned as failed worker results', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-orchestrator-error-'));
  const events = [];
  let result;
  const providerFactory = () => ({
    async stream(messages, { onDelta }) {
      if (messages.some((message) => /Create a concise chat title/.test(message.content || ''))) return { text: 'Title' };
      if (messages.some((message) => /You are a Cuppet subagent/.test(message.content || ''))) {
        const text = "The MCP server 'browser' failed to initialize: address already in use";
        await onDelta(text); return { text };
      }
      const reply = messages.find((message) => message.role === 'tool' && message.name === 'cuppet_delegate');
      if (reply) { result = JSON.parse(reply.content); await onDelta('The worker failed.'); return { text: 'The worker failed.' }; }
      return { toolCalls: [{ id: 'delegate-error', name: 'cuppet_delegate', arguments: JSON.stringify({ tasks: ['Inspect this task'] }) }] };
    },
  });
  const runtime = new RuntimeService({ databasePath: join(dir, 'db.sqlite3'), dataDir: dir, emit: (event) => events.push(event), providerFactory, tst: { configured: false, status: { configured: false }, close() {} }, backgroundFactory: backgroundStub });
  try {
    const session = await runtime.handle('session.create');
    await runtime.handle('orchestrator.set', { enabled: true });
    await runtime.handle('session.send', { sessionId: session.id, text: 'Run a worker', provider: { providerID: 'openai-compatible', apiKey: 'test', model: 'primary', backgroundModel: 'secondary' } });
    await waitFor(events, (event) => event.type === 'run.finished');
    assert.equal(result.workers[0].status, 'failed');
    assert.match(result.workers[0].error, /failed to initialize/);
    assert.ok(events.some((event) => event.type === 'runtime.activity' && event.activity?.tool === 'cuppet_subagent' && event.activity.status === 'error'));
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});

test('worker file edits use the parent session permission and mutation journal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-orchestrator-write-'));
  const projectRoot = join(dir, 'project');
  await mkdir(projectRoot);
  const events = [];
  const providerFactory = () => ({
    async stream(messages, { onDelta }) {
      if (messages.some((message) => /Create a concise chat title/.test(message.content || ''))) return { text: 'Title' };
      const worker = messages.some((message) => /You are a Cuppet subagent/.test(message.content || ''));
      const toolMessages = messages.filter((message) => message.role === 'tool');
      if (worker && !toolMessages.length) return { toolCalls: [{ id: 'prepare', name: 'tst_edit_batch', arguments: JSON.stringify({ action: 'prepare', operations: [{ op: 'create_file', path: 'worker.txt', content: 'worker output\n' }] }) }] };
      if (worker && toolMessages.length === 1) return { toolCalls: [{ id: 'write', name: 'workspace_write', arguments: JSON.stringify({ path: 'worker.txt', content: 'worker output\n' }) }] };
      if (worker) { await onDelta('Created the file.'); return { text: 'Created the file.' }; }
      if (!toolMessages.length) return { toolCalls: [{ id: 'delegate', name: 'cuppet_delegate', arguments: JSON.stringify({ tasks: [{ name: 'Writer', task: 'Create worker.txt' }] }) }] };
      await onDelta('Worker finished.'); return { text: 'Worker finished.' };
    },
  });
  const runtime = new RuntimeService({ databasePath: join(dir, 'db.sqlite3'), dataDir: join(dir, 'runtime'), emit: (event) => events.push(event), providerFactory, tst: { configured: false, status: { configured: false }, close() {} }, backgroundFactory: backgroundStub });
  try {
    const project = await runtime.handle('project.add-local', { path: projectRoot, name: 'Project' });
    const session = await runtime.handle('session.create', { projectId: project.id });
    await runtime.handle('orchestrator.set', { enabled: true });
    await runtime.handle('session.send', { sessionId: session.id, text: 'Create a file', provider: { providerID: 'openai-compatible', apiKey: 'test', model: 'primary', backgroundModel: 'secondary' } });
    const permission = (await waitFor(events, (event) => event.type === 'permission.requested')).request;
    assert.equal(permission.sessionId, session.id);
    assert.match(permission.description, /^Subagent Writer:/);
    assert.deepEqual(permission.resources, ['worker.txt']);
    await runtime.handle('permission.reply', { requestId: permission.id, reply: 'once' });
    await waitFor(events, (event) => event.type === 'run.finished');
    assert.equal(await readFile(join(projectRoot, 'worker.txt'), 'utf8'), 'worker output\n');
    const restored = await runtime.handle('session.get', { sessionId: session.id });
    assert.equal(restored.toolExecutions.find((execution) => execution.toolName === 'workspace_write')?.permissionSource, 'user-once');
    const undone = await runtime.handle('session.undo', { sessionId: session.id });
    assert.equal(undone.undone, true);
    await assert.rejects(() => readFile(join(projectRoot, 'worker.txt'), 'utf8'), { code: 'ENOENT' });
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});

const acpFixture = fileURLToPath(new URL('./fixtures/fake-orchestration-acp-agent.mjs', import.meta.url));
for (const providerID of ['opencode', 'claude-code', 'github-copilot', 'grok-build', 'mistral-vibe', 'kiro', 'antigravity']) {
  test(`orchestration crosses the ACP tool bridge with ${providerID} provider settings`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cuppet-orchestrator-acp-'));
    const events = [];
    if (providerID === 'antigravity') await mkdir(join(dir, 'gemini', 'antigravity-acp'), { recursive: true });
    const base = providerID === 'antigravity'
      ? antigravityAcpDescriptor({ command: process.execPath, args: [acpFixture], harnessPath: acpFixture })
      : localCliDescriptor(providerID);
    const descriptor = { ...base, command: process.execPath, args: [acpFixture], prepareEnvironment: undefined, assertProjectAccess: undefined, resolveRuntime: undefined, cleanupSessions: undefined, authentication: undefined, requiredSessionSettings: undefined, sessionCommandSettings: undefined };
    const providerFactory = (configuration) => new AcpProviderAdapter(configuration, { descriptor });
    const runtime = new RuntimeService({ databasePath: join(dir, 'db.sqlite3'), dataDir: dir, emit: (event) => events.push(event), providerFactory, tst: { configured: false, status: { configured: false }, close() {} }, backgroundFactory: backgroundStub });
    try {
      const session = await runtime.handle('session.create');
      await runtime.handle('orchestrator.set', { enabled: true });
      await runtime.handle('session.send', { sessionId: session.id, text: 'Use two workers', provider: { providerID, model: 'provider/primary', backgroundModel: 'provider/secondary', primary: { providerID, modelID: 'provider/primary' }, secondary: { providerID, modelID: 'provider/secondary' }, ...(providerID === 'antigravity' ? { cliEnv: { GEMINI_HOME: join(dir, 'gemini') } } : {}) } });
      await waitFor(events, (event) => event.type === 'run.finished', 15000);
      const restored = await runtime.handle('session.get', { sessionId: session.id });
      assert.equal(restored.messages.at(-1).status, 'complete', JSON.stringify(events.filter((event) => event.type === 'runtime.error')));
      assert.equal(restored.messages.at(-1).content, 'Both workers returned.');
      assert.equal(events.filter((event) => event.type === 'runtime.activity' && event.activity?.tool === 'cuppet_subagent' && event.activity.status === 'success').length, 2);
    } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
  });
}

test('an ACP coordinator is not treated as stalled while its workers run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-orchestrator-acp-wait-'));
  const events = [];
  const providerID = 'claude-code';
  const descriptor = { ...localCliDescriptor(providerID), command: process.execPath, args: [acpFixture], cleanupSessions: undefined, environment: (env) => ({ ...env, FAKE_ORCHESTRATION_WORKER_DELAY_MS: '700' }) };
  const providerFactory = (configuration) => new AcpProviderAdapter(configuration, { descriptor });
  const providerRuntimeManager = new ProviderRuntimeManager({ acpRuntimeFactory: ({ descriptor: value, configuration, projectRoot }) => new AcpSessionRuntime({ descriptor: value, configuration, projectRoot, liveness: { inactivityMs: 200, cancelGraceMs: 50 } }), usageRecorder: async () => {} });
  const runtime = new RuntimeService({ databasePath: join(dir, 'db.sqlite3'), dataDir: dir, emit: (event) => events.push(event), providerFactory, providerRuntimeManager, tst: { configured: false, status: { configured: false }, close() {} }, backgroundFactory: backgroundStub });
  try {
    const session = await runtime.handle('session.create');
    await runtime.handle('orchestrator.set', { enabled: true });
    await runtime.handle('session.send', { sessionId: session.id, text: 'Use two workers', provider: { providerID, model: 'provider/primary', backgroundModel: 'provider/secondary', primary: { providerID, modelID: 'provider/primary' }, secondary: { providerID, modelID: 'provider/secondary' } } });
    await waitFor(events, (event) => event.type === 'run.finished', 15000);
    const restored = await runtime.handle('session.get', { sessionId: session.id });
    assert.equal(restored.messages.at(-1).status, 'complete', JSON.stringify(events.filter((event) => event.type === 'runtime.error')));
    assert.equal(restored.messages.at(-1).content, 'Both workers returned.');
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});

test('orchestration uses Codex dynamic tools and separate secondary-model threads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-orchestrator-codex-'));
  const events = [];
  const workerModels = [];
  class FakeCodex extends EventEmitter {
    async start() {}
    async close() {}
    async request(method, params = {}) {
      if (method === 'account/read') return { account: { type: 'chatgpt' } };
      if (method === 'thread/start') { this.thread = params; return { thread: { id: 'thread' } }; }
      if (method === 'turn/start') {
        const prompt = JSON.stringify(params.input);
        if (prompt.includes('You are a Cuppet subagent')) {
          workerModels.push(this.thread.model);
          queueMicrotask(() => this.finish('Codex worker complete.'));
        } else if (this.thread.dynamicTools.some((tool) => tool.name === 'cuppet_delegate')) {
          queueMicrotask(() => this.emit('request', { id: 1, method: 'item/tool/call', params: { callId: 'delegate', tool: 'cuppet_delegate', arguments: { tasks: [{ name: 'One', task: 'first task' }, { name: 'Two', task: 'second task' }] } } }));
        } else queueMicrotask(() => this.finish('Title'));
        return { turn: { id: 'turn' } };
      }
      return {};
    }
    respond(_id, result) {
      assert.equal(result.success, true);
      assert.match(result.contentItems[0].text, /Codex worker complete/);
      queueMicrotask(() => this.finish('Both Codex workers returned.'));
    }
    respondError(_id, message) { throw new Error(message); }
    finish(text) {
      this.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: 'turn', delta: text } });
      this.emit('notification', { method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } });
    }
  }
  const providerFactory = (configuration) => new CodexSubscriptionProvider({ ...configuration, codexLaunch: { command: 'fake', args: [] }, clientFactory: () => new FakeCodex() });
  const runtime = new RuntimeService({ databasePath: join(dir, 'db.sqlite3'), dataDir: dir, emit: (event) => events.push(event), providerFactory, tst: { configured: false, status: { configured: false }, close() {} }, backgroundFactory: backgroundStub });
  try {
    const session = await runtime.handle('session.create');
    await runtime.handle('orchestrator.set', { enabled: true });
    await runtime.handle('session.send', { sessionId: session.id, text: 'Run two workers', provider: { providerID: 'codex', model: 'primary', backgroundModel: 'secondary', primary: { providerID: 'codex', modelID: 'primary' }, secondary: { providerID: 'codex', modelID: 'secondary' } } });
    await waitFor(events, (event) => event.type === 'run.finished');
    const restored = await runtime.handle('session.get', { sessionId: session.id });
    assert.equal(restored.messages.at(-1).content, 'Both Codex workers returned.');
    assert.deepEqual(workerModels, ['secondary', 'secondary']);
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});

for (const providerID of ['openai', 'anthropic', 'google', 'google-vertex', 'openai-compatible', 'qwen', 'deepseek', 'kimi', 'zai', 'meta', 'openrouter']) {
  test(`orchestration works through the ${providerID} API transport`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cuppet-orchestrator-api-'));
    const events = [];
    const workerModels = [];
    const taskArgs = { tasks: [{ name: 'One', task: 'first task' }, { name: 'Two', task: 'second task' }] };
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      const serialized = JSON.stringify(body);
      const worker = serialized.includes('You are a Cuppet subagent');
      const title = serialized.includes('Create a concise chat title');
      const continued = serialized.includes('first worker result');
      if (worker) workerModels.push(providerID === 'google-vertex' ? String(url).match(/models\/([^/:?]+)/)?.[1] : body.model);
      let payload;
      if (providerID === 'openai') payload = worker || title || continued
        ? { output_text: title ? 'Title' : worker ? 'first worker result' : 'Both API workers returned.' }
        : { output: [{ type: 'function_call', id: 'fc', call_id: 'delegate', name: 'cuppet_delegate', arguments: JSON.stringify(taskArgs) }] };
      else if (providerID === 'anthropic') payload = { content: worker || title || continued
        ? [{ type: 'text', text: title ? 'Title' : worker ? 'first worker result' : 'Both API workers returned.' }]
        : [{ type: 'tool_use', id: 'delegate', name: 'cuppet_delegate', input: taskArgs }] };
      else if (providerID === 'google') payload = { steps: worker || title || continued
        ? [{ type: 'model_output', content: [{ type: 'text', text: title ? 'Title' : worker ? 'first worker result' : 'Both API workers returned.' }] }]
        : [{ type: 'function_call', id: 'delegate', name: 'cuppet_delegate', arguments: taskArgs }] };
      else if (providerID === 'google-vertex') payload = { candidates: [{ content: { role: 'model', parts: worker || title || continued
        ? [{ text: title ? 'Title' : worker ? 'first worker result' : 'Both API workers returned.' }]
        : [{ functionCall: { id: 'delegate', name: 'cuppet_delegate', args: taskArgs } }] }, finishReason: 'STOP' }] };
      else payload = { choices: [{ message: worker || title || continued
        ? { role: 'assistant', content: title ? 'Title' : worker ? 'first worker result' : 'Both API workers returned.' }
        : { role: 'assistant', content: null, tool_calls: [{ id: 'delegate', type: 'function', function: { name: 'cuppet_delegate', arguments: JSON.stringify(taskArgs) } }] } }] };
      return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
    };
    const providerFactory = (configuration) => createUntrackedChatProvider({ ...configuration, fetchImpl });
    const runtime = new RuntimeService({ databasePath: join(dir, 'db.sqlite3'), dataDir: dir, emit: (event) => events.push(event), providerFactory, tst: { configured: false, status: { configured: false }, close() {} }, backgroundFactory: backgroundStub });
    try {
      const session = await runtime.handle('session.create');
      await runtime.handle('orchestrator.set', { enabled: true });
      await runtime.handle('session.send', { sessionId: session.id, text: 'Use two workers', provider: { providerID, apiKey: 'test', model: 'primary', backgroundModel: 'secondary' } });
      await waitFor(events, (event) => event.type === 'run.finished');
      const restored = await runtime.handle('session.get', { sessionId: session.id });
      assert.equal(restored.messages.at(-1).status, 'complete', JSON.stringify(events.filter((event) => event.type === 'runtime.error')));
      assert.equal(restored.messages.at(-1).content, 'Both API workers returned.');
      assert.deepEqual(workerModels, ['secondary', 'secondary']);
    } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
  });
}
