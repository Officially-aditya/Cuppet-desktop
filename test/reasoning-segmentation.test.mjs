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
  const tool = h.events.find((event) => event.type === 'tool.started');
  assert.equal(tool?.messageId, 'msg_assistant');
  assert.equal(tool?.tool, 'cuppet_plan');
  assert.equal(tool?.argumentsJson, '{"action":"overview"}');
});

test('two tool rounds preserve reasoning -> tool -> reasoning -> tool -> final order', async () => {
  let call = 0;
  const adapter = {
    async stream(_messages, options) {
      call += 1;
      if (call === 1) {
        options.onDelta('First I will inspect the plan.');
        return { text: 'First I will inspect the plan.', toolCalls: [{ id: 'tool_a', name: 'cuppet_plan', arguments: '{"action":"overview"}' }] };
      }
      if (call === 2) {
        options.onDelta('Now I need one more check.');
        return { text: 'Now I need one more check.', toolCalls: [{ id: 'tool_b', name: 'cuppet_plan', arguments: '{"action":"overview"}' }] };
      }
      options.onDelta('Clean final summary.');
      return { text: 'Clean final summary.', toolCalls: [] };
    },
  };
  const h = harness(adapter);
  await h.run();

  const chain = h.events
    .filter((event) => event.type === 'message.reasoning' || event.type === 'tool.started')
    .map((event) => event.type === 'message.reasoning' ? `reason:${event.segment}` : `tool:${event.callId}`);
  assert.deepEqual(chain, [
    'reason:First I will inspect the plan.',
    'tool:tool_a',
    'reason:Now I need one more check.',
    'tool:tool_b',
  ]);
  assert.deepEqual(h.final, ['Clean final summary.']);
  for (const event of h.events.filter((event) => event.type === 'tool.started' || event.type === 'tool.finished')) {
    assert.equal(event.messageId, 'msg_assistant');
    assert.equal(event.tool, 'cuppet_plan');
    assert.equal(event.argumentsJson, '{"action":"overview"}');
  }
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
  const tool = h.events.find((event) => event.type === 'tool.started');
  assert.equal(tool?.messageId, 'msg_assistant');
  assert.equal(tool?.tool, 'cuppet_plan');
  assert.equal(tool?.argumentsJson, '{"action":"overview"}');
  const previews = h.events.filter((event) => event.type === 'message.preview').map((event) => event.content);
  assert.ok(previews.includes('I will read the workspace.'));
  assert.ok(previews.includes('Here is the final summary after the tool.'));
});


test('provider-native ACP reasoning and tool lifecycle are bridged into the chat trace', async () => {
  const adapter = {
    async stream(_messages, options) {
      await options.onProviderEvent({ type: 'reasoning', text: 'Inspecting the repository.' });
      await options.onProviderEvent({ type: 'tool.started', callId: 'acp_tool_1', tool: 'search', argumentsJson: '{"query":"TODO"}' });
      await options.onProviderEvent({ type: 'tool.finished', callId: 'acp_tool_1', tool: 'search', argumentsJson: '{"query":"TODO"}', success: true, message: '2 matches' });
      options.onDelta('Final answer.');
      return { text: 'Final answer.', toolCalls: [] };
    },
  };
  const h = harness(adapter);
  await h.run();
  assert.deepEqual(h.final, ['Final answer.']);
  assert.ok(h.events.some((event) => event.type === 'message.reasoning' && event.messageId === 'msg_assistant' && event.segment === 'Inspecting the repository.'));
  const started = h.events.find((event) => event.type === 'tool.started' && event.callId === 'acp_tool_1');
  const finished = h.events.find((event) => event.type === 'tool.finished' && event.callId === 'acp_tool_1');
  assert.equal(started?.messageId, 'msg_assistant');
  assert.equal(started?.tool, 'search');
  assert.equal(finished?.success, true);
  assert.equal(finished?.message, '2 matches');
});
