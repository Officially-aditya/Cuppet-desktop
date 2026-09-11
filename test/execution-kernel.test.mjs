import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutionKernel, executionPathForTool } from '../src/runtime/execution/execution-kernel.mjs';
import { JournaledToolRuntime } from '../src/runtime/journaled-tool-runtime.mjs';

const definition = (name) => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } });

test('ExecutionKernel classifies and measures optimized Cuppet execution paths', async () => {
  assert.equal(executionPathForTool('tst_edit_batch'), 'optimized');
  assert.equal(executionPathForTool('tst_read'), 'optimized');
  assert.equal(executionPathForTool('workspace_read'), 'raw-fallback');
  assert.equal(executionPathForTool('workspace_write'), 'raw-fallback');
  assert.equal(executionPathForTool('bash'), 'raw-fallback');
  assert.equal(executionPathForTool('cuppet_execute'), 'semantic');
  assert.equal(executionPathForTool('cuppet_memory_search'), 'semantic');
  assert.equal(executionPathForTool('browser_observe'), 'semantic');

  const events = [];
  let now = 100;
  const kernel = new ExecutionKernel({ emit: (event) => events.push(event), now: () => now++ });
  const result = await kernel.execute({ id: '1', name: 'tst_edit_batch', arguments: '{}' }, {
    sessionId: 'chat-1', projectRoot: '/tmp/project', execute: async () => ({ success: true, output: 'ok', paths: ['a.ts', 'b.ts'], mutation: true }),
  });
  assert.equal(result.output, 'ok');
  const metrics = kernel.snapshot('chat-1');
  assert.equal(metrics.optimized, 1);
  assert.equal(metrics.executed, 1);
  assert.equal(metrics.completed, 1);
  assert.equal(metrics.successes, 1);
  assert.equal(metrics.optimizedExecuted, 1);
  assert.equal(metrics.optimizedSuccesses, 1);
  assert.equal(metrics.rawFallbackExecuted, 0);
  assert.equal(metrics.outputBytes, 2);
  assert.equal(metrics.pathsTouched, 2);
  assert.equal(metrics.mutations, 1);
  assert.equal(metrics.durationMs, 1);
  assert.deepEqual(events.map((event) => [event.type, event.path]), [
    ['execution.kernel.started', 'optimized'],
    ['execution.kernel.completed', 'optimized'],
  ]);
  assert.equal(events[1].outputBytes, 2);
  assert.equal(events[1].pathsTouched, 2);
});

test('provider tool surface requires structured reads before raw read fallback', async () => {
  const kernel = new ExecutionKernel();
  const tools = [definition('workspace_read'), definition('bash'), definition('tst_explore'), definition('tst_read')];
  const initial = kernel.toolsForProvider(tools, { sessionId: 'chat-read' }).map((item) => item.function.name);
  assert.deepEqual(initial, ['tst_explore', 'tst_read', 'cuppet_execute']);

  let called = false;
  const blocked = await kernel.execute({ id: 'raw-read-1', source: 'acp-host', name: 'workspace_read', arguments: '{}' }, {
    sessionId: 'chat-read', projectRoot: '/tmp/project', execute: async () => { called = true; return { success: true }; },
  });
  assert.equal(called, false);
  assert.equal(blocked.success, false);
  assert.match(blocked.output, /tst_explore\/tst_read/);
  assert.equal(kernel.snapshot('chat-read').blockedRawReads, 1);
  assert.equal(kernel.snapshot('chat-read').executed, 0);
  assert.equal(kernel.snapshot('chat-read').rawReadFallback, false);

  await kernel.execute({ id: 'structured-read-1', name: 'tst_read', arguments: '{}' }, {
    sessionId: 'chat-read', projectRoot: '/tmp/project', execute: async () => ({ success: false, output: 'unsupported file shape' }),
  });
  const fallback = kernel.toolsForProvider(tools, { sessionId: 'chat-read' }).map((item) => item.function.name);
  assert.deepEqual(fallback, ['tst_explore', 'tst_read', 'cuppet_execute', 'workspace_read']);
  const metrics = kernel.snapshot('chat-read');
  assert.equal(metrics.rawReadFallback, true);
  assert.equal(metrics.fallbackUnlocks, 1);
  assert.equal(metrics.optimizedFailures, 1);
});

test('provider tool surface requires batch edits before raw mutation fallback', async () => {
  const kernel = new ExecutionKernel();
  const tools = [definition('workspace_write'), definition('bash'), definition('tst_edit_batch'), definition('workspace_edit'), definition('tst_read')];
  const initial = kernel.toolsForProvider(tools, { sessionId: 'chat-1' }).map((item) => item.function.name);
  assert.deepEqual(initial, ['tst_edit_batch', 'tst_read', 'cuppet_execute']);

  let called = false;
  const blocked = await kernel.execute({ id: 'raw-1', source: 'acp-host', name: 'workspace_write', arguments: '{}' }, {
    sessionId: 'chat-1', projectRoot: '/tmp/project', execute: async () => { called = true; return { success: true }; },
  });
  assert.equal(called, false);
  assert.equal(blocked.success, false);
  assert.match(blocked.output, /tst_edit_batch/);
  assert.equal(kernel.snapshot('chat-1').blockedRawMutations, 1);

  await kernel.execute({ id: 'batch-1', name: 'tst_edit_batch', arguments: '{}' }, {
    sessionId: 'chat-1', projectRoot: '/tmp/project', execute: async () => ({ success: false, output: 'unsupported structure' }),
  });
  const fallback = kernel.toolsForProvider(tools, { sessionId: 'chat-1' }).map((item) => item.function.name);
  assert.deepEqual(fallback, ['tst_edit_batch', 'tst_read', 'cuppet_execute', 'workspace_write', 'workspace_edit']);
  const metrics = kernel.snapshot('chat-1');
  assert.equal(metrics.rawMutationFallback, true);
  assert.equal(metrics.fallbackUnlocks, 1);
  assert.equal(metrics.optimizedFailures, 1);
});

test('native ACP terminal cannot bypass Cuppet command mediation', async () => {
  const kernel = new ExecutionKernel();
  let called = false;
  const result = await kernel.execute({ id: 'native-shell', source: 'acp-host', name: 'bash', arguments: '{"command":"npm test"}' }, {
    sessionId: 'chat-shell', projectRoot: '/tmp/project', execute: async () => { called = true; return { success: true }; },
  });
  assert.equal(called, false);
  assert.equal(result.success, false);
  assert.match(result.output, /cuppet_execute/);
  assert.equal(kernel.snapshot('chat-shell').blockedNativeShell, 1);
});

test('cuppet_execute allows project commands but blocks shell read/write bypasses until optimized fallback', async () => {
  const kernel = new ExecutionKernel();
  const calls = [];
  const run = (call) => kernel.execute(call, {
    sessionId: 'chat-command', projectRoot: '/tmp/project', execute: async (translated) => {
      calls.push(translated);
      return { success: true, output: 'ok', paths: [] };
    },
  });

  const validation = await run({ id: 'cmd-1', name: 'cuppet_execute', arguments: '{"command":"npm test"}' });
  assert.equal(validation.success, true);
  assert.equal(calls[0].name, 'bash');
  assert.equal(calls[0].source, 'cuppet-execute');

  const read = await run({ id: 'cmd-2', name: 'cuppet_execute', arguments: '{"command":"cat src/main.ts"}' });
  assert.equal(read.success, false);
  assert.match(read.output, /tst_explore\/tst_read/);

  const mutation = await run({ id: 'cmd-3', name: 'cuppet_execute', arguments: '{"command":"sed -i s\/old\/new\/ src/main.ts"}' });
  assert.equal(mutation.success, false);
  assert.match(mutation.output, /tst_edit_batch/);

  const metrics = kernel.snapshot('chat-command');
  assert.equal(metrics.semanticExecuted, 1);
  assert.equal(metrics.blockedShellReads, 1);
  assert.equal(metrics.blockedShellMutations, 1);
});

test('JournaledToolRuntime routes provider tool calls through the shared ExecutionKernel', async () => {
  const calls = [];
  const executionKernel = {
    toolsForProvider(tools) { return tools; },
    async execute(call, context) {
      calls.push({ call, sessionId: context.sessionId, projectRoot: context.projectRoot });
      return context.execute(call);
    },
    snapshot(sessionId) { return { sessionId, total: calls.length }; },
    forget() {},
  };
  const adapter = {
    async stream(_messages, options) {
      await options.executeTool({ id: 'tool-1', name: 'cuppet_plan', arguments: '{"action":"overview"}' });
      options.onDelta('Done.');
      return { text: 'Done.', toolCalls: [] };
    },
  };
  const runtime = new JournaledToolRuntime({
    journal: null,
    executionKernel,
    providerRuntimeManager: { adapterFor: ({ adapter: value }) => value, close: async () => {}, forget: async () => false },
    db: {
      getSession: () => ({ messages: [{ id: 'assistant-1', role: 'assistant', status: 'streaming', content: '' }] }),
      createToolExecution: () => ({}),
      finishToolExecution: () => ({}),
    },
    tst: { configured: false },
    planStore: { toolResult: async () => 'plan' },
    permissions: { authorize: async () => ({ source: 'test' }) },
    questions: null,
  });
  const final = [];
  await runtime.run({ adapter, messages: [{ role: 'user', content: 'work' }], sessionId: 'chat-1', projectRoot: '/tmp/project', onDelta: async (value) => final.push(value) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].call.name, 'cuppet_plan');
  assert.equal(calls[0].sessionId, 'chat-1');
  assert.equal(calls[0].projectRoot, '/tmp/project');
  assert.deepEqual(runtime.executionSnapshot('chat-1'), { sessionId: 'chat-1', total: 1 });
  assert.deepEqual(final, ['Done.']);
});
