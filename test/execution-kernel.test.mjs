import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutionKernel, executionPathForTool } from '../src/runtime/execution/execution-kernel.mjs';
import { JournaledToolRuntime } from '../src/runtime/journaled-tool-runtime.mjs';

test('ExecutionKernel classifies optimized and fallback Cuppet execution paths', async () => {
  assert.equal(executionPathForTool('tst_edit_batch'), 'optimized');
  assert.equal(executionPathForTool('tst_read'), 'optimized');
  assert.equal(executionPathForTool('workspace_write'), 'raw-fallback');
  assert.equal(executionPathForTool('bash'), 'raw-fallback');
  assert.equal(executionPathForTool('cuppet_memory_search'), 'semantic');
  assert.equal(executionPathForTool('browser_observe'), 'semantic');

  const events = [];
  let now = 100;
  const kernel = new ExecutionKernel({ emit: (event) => events.push(event), now: () => now++ });
  const result = await kernel.execute({ id: '1', name: 'tst_edit_batch', arguments: '{}' }, {
    sessionId: 'chat-1', projectRoot: '/tmp/project', execute: async () => ({ success: true, output: 'ok' }),
  });
  assert.equal(result.output, 'ok');
  assert.equal(kernel.snapshot('chat-1').optimized, 1);
  assert.deepEqual(events.map((event) => [event.type, event.path]), [
    ['execution.kernel.started', 'optimized'],
    ['execution.kernel.completed', 'optimized'],
  ]);
});

test('JournaledToolRuntime routes provider tool calls through the shared ExecutionKernel', async () => {
  const calls = [];
  const executionKernel = {
    async execute(call, context) {
      calls.push({ call, sessionId: context.sessionId, projectRoot: context.projectRoot });
      return context.execute(call);
    },
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
  assert.deepEqual(final, ['Done.']);
});
