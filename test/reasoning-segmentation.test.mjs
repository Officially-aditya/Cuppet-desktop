import assert from 'node:assert/strict';
import test from 'node:test';
import { JournaledToolRuntime } from '../src/runtime/journaled-tool-runtime.mjs';

function harness(adapter) {
  const events = [];
  const final = [];
  const messages = [{ id: 'msg_user', role: 'user', status: 'complete', content: 'do work' }, { id: 'msg_assistant', role: 'assistant', status: 'streaming', content: '' }];
  const db = {
    getSession: () => ({ id: 'session_1', messages }),
    createToolExecution: () => ({}),
    finishToolExecution: () => ({}),
  };
  const runtime = new JournaledToolRuntime({
    journal: null,
    db,
    emit: (event) => events.push(event),
    tst: { configured: false },
    planStore: { toolResult: async () => 'plan result' },
    permissions: { authorize: async () => ({ source: 'test' }) },
    questions: null,
  });
  return {
    events,
    final,
    run: () => runtime.run({
      adapter,
      messages: [{ role: 'user', content: 'do work' }],
      sessionId: 'session_1',
      onDelta: async (delta) => final.push(delta),
    }),
  };
}

test('generic tool-loop text before a tool is reasoning and only the final pass reaches the durable answer', async () => {
  let call = 0;
  const adapter = {
    async stream(_messages, options) {
      call += 1;
      if (call === 1) {
        options.onDelta('I should inspect the plan first.');
        return { text: 'I should inspect the plan first.', toolCalls: [{ id: 'tool_1', name: 'cuppet_plan', arguments: '{"action":"overview"}' }] };
      }
      options.onDelta('Final summary.');
      return { text: 'Final summary.', toolCalls: [] };
    },
  };
  const h = harness(adapter);
  await h.run();
  assert.deepEqual(h.final, ['Final summary.']);
  assert.equal(h.events.find((event) => event.type === 'message.reasoning')?.segment, 'I should inspect the plan first.');
  assert.ok(h.events.some((event) => event.type === 'message.preview' && event.content === 'I should inspect the plan first.'));
  assert.ok(h.events.some((event) => event.type === 'message.preview' && event.content === ''));
});

test('Codex-style in-stream dynamic tool calls split the next paragraph from pre-tool reasoning', async () => {
  const adapter = {
    async stream(_messages, options) {
      options.onDelta('I will read the workspace.');
      const result = await options.executeTool({ id: 'tool_2', name: 'cuppet_plan', arguments: '{"action":"overview"}' });
      assert.equal(result.success, true);
      options.onDelta('Here is the final summary after the tool.');
      return { text: 'I will read the workspace.Here is the final summary after the tool.', toolCalls: [] };
    },
  };
  const h = harness(adapter);
  await h.run();
  assert.deepEqual(h.final, ['Here is the final summary after the tool.']);
  const reasoning = h.events.filter((event) => event.type === 'message.reasoning');
  assert.equal(reasoning.length, 1);
  assert.equal(reasoning[0].messageId, 'msg_assistant');
  assert.equal(reasoning[0].segment, 'I will read the workspace.');
  const previews = h.events.filter((event) => event.type === 'message.preview').map((event) => event.content);
  assert.ok(previews.includes('I will read the workspace.'));
  assert.ok(previews.includes('Here is the final summary after the tool.'));
});
