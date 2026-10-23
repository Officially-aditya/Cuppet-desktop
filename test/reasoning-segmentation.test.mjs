import assert from 'node:assert/strict';
import test from 'node:test';
import { JournaledToolRuntime } from '../src/runtime/journaled-tool-runtime.mjs';
import { providerActivity } from '../src/runtime/providers/activity.mjs';
import { reduceTranscriptEvent } from '../src/renderer/react/chat-transcript.ts';

function isProviderActivity(event, type) {
  return event?.type === 'runtime.activity'
    && event?.source === 'provider'
    && event?.activity?.type === type;
}

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
    run: (options = {}) => runtime.run({
      adapter,
      messages: [{ role: 'user', content: 'do work' }],
      sessionId: 'session_1',
      onDelta: async (delta) => final.push(delta),
      ...options,
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
  assert.equal(
    h.events.find((event) => isProviderActivity(event, 'activity.reasoning.delta'))?.activity?.text,
    'I should inspect the plan first.',
  );
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
    .filter((event) => isProviderActivity(event, 'activity.reasoning.delta') || event.type === 'tool.started')
    .map((event) => isProviderActivity(event, 'activity.reasoning.delta')
      ? `reason:${event.activity.text}`
      : `tool:${event.callId}`);
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
  const reasoning = h.events.filter((event) => isProviderActivity(event, 'activity.reasoning.delta'));
  assert.equal(reasoning.length, 1);
  assert.equal(reasoning[0].messageId, 'msg_assistant');
  assert.equal(reasoning[0].activity.text, 'I will read the workspace.');
  const tool = h.events.find((event) => event.type === 'tool.started');
  assert.equal(tool?.messageId, 'msg_assistant');
  assert.equal(tool?.tool, 'cuppet_plan');
  assert.equal(tool?.argumentsJson, '{"action":"overview"}');
  const previews = h.events.filter((event) => event.type === 'message.preview').map((event) => event.content);
  assert.ok(previews.includes('I will read the workspace.'));
  assert.ok(previews.includes('Here is the final summary after the tool.'));
});

test('canonical provider reasoning and tool telemetry remain distinct from execution lifecycle', async () => {
  const adapter = {
    async stream(_messages, options) {
      await options.onActivity(providerActivity('activity.reasoning.delta', { text: 'Inspecting the repository.' }));
      await options.onActivity(providerActivity('activity.tool.opened', { callId: 'acp_tool_1', tool: 'search', argumentsJson: '{"query":"TODO"}' }));
      await options.onActivity(providerActivity('activity.tool.closed', { callId: 'acp_tool_1', tool: 'search', argumentsJson: '{"query":"TODO"}', status: 'success', details: '2 matches' }));
      options.onDelta('Final answer.');
      return { text: 'Final answer.', toolCalls: [] };
    },
  };
  const h = harness(adapter);
  await h.run();
  assert.deepEqual(h.final, ['Final answer.']);

  const reasoning = h.events.find((event) => isProviderActivity(event, 'activity.reasoning.delta'));
  assert.equal(reasoning?.messageId, 'msg_assistant');
  assert.equal(reasoning?.activity?.text, 'Inspecting the repository.');

  const opened = h.events.find((event) => isProviderActivity(event, 'activity.tool.opened') && event.activity?.callId === 'acp_tool_1');
  const closed = h.events.find((event) => isProviderActivity(event, 'activity.tool.closed') && event.activity?.callId === 'acp_tool_1');
  assert.equal(opened?.messageId, 'msg_assistant');
  assert.equal(opened?.activity?.tool, 'search');
  assert.equal(opened?.activity?.argumentsJson, '{"query":"TODO"}');
  assert.equal(closed?.messageId, 'msg_assistant');
  assert.equal(closed?.activity?.status, 'success');
  assert.equal(closed?.activity?.details, '2 matches');
  assert.equal(
    h.events.some((event) => (event.type === 'tool.started' || event.type === 'tool.finished') && event.callId === 'acp_tool_1'),
    false,
  );
});

test('provider-managed tool rounds move progress out of the final answer', async () => {
  const h = harness({
    async stream(_messages, options) {
      options.onDelta('Let me check the maintainers.');
      await options.onActivity(providerActivity('activity.tool.opened', { callId: 'native-1', tool: 'search' }));
      await options.onActivity(providerActivity('activity.tool.closed', { callId: 'native-1', tool: 'search', status: 'success' }));
      await options.onActivity(providerActivity('activity.reasoning.delta', { text: 'The results need a closer look.' }));
      options.onDelta('Checking one more detail.');
      await options.onActivity(providerActivity('activity.tool.opened', { callId: 'native-2', tool: 'read' }));
      await options.onActivity(providerActivity('activity.tool.closed', { callId: 'native-2', tool: 'read', status: 'success' }));
      options.onDelta('Here are the three buckets.');
      return { text: 'Let me check the maintainers.Checking one more detail.Here are the three buckets.', toolCalls: [] };
    },
  });
  await h.run();
  assert.deepEqual(h.final, ['Here are the three buckets.']);
  const reasoning = h.events.filter((event) => isProviderActivity(event, 'activity.reasoning.delta'));
  assert.deepEqual(reasoning.map(({ activity }) => [activity.text, activity.kind]), [
    ['Let me check the maintainers.', 'commentary'],
    ['The results need a closer look.', undefined],
    ['Checking one more detail.', 'commentary'],
  ]);
  for (const { activity, createdAt } of reasoning.filter(({ activity }) => activity.kind === 'commentary')) {
    assert.ok(activity.completedAt >= activity.startedAt);
    assert.ok(createdAt >= activity.completedAt);
  }
  const activityTypes = h.events.filter((event) => event.type === 'runtime.activity').map((event) => event.activity.type);
  assert.equal(activityTypes[0], 'activity.reasoning.delta');
  assert.equal(activityTypes[1], 'activity.tool.opened');
});

test('a turn ending after provider tools does not restore the accumulated progress as an answer', async () => {
  const h = harness({
    async stream(_messages, options) {
      options.onDelta('Inspecting the workspace.');
      await options.onActivity(providerActivity('activity.tool.opened', { callId: 'native-only', tool: 'read' }));
      await options.onActivity(providerActivity('activity.tool.closed', { callId: 'native-only', tool: 'read', status: 'success' }));
      return { text: 'Inspecting the workspace.', toolCalls: [] };
    },
  });
  await h.run();
  assert.deepEqual(h.final, []);
  assert.equal(h.events.filter((event) => isProviderActivity(event, 'activity.reasoning.delta')).length, 1);
});

test('providers without reasoning preserve the complete answer without creating thoughts', async () => {
  for (const streaming of [true, false]) {
    const h = harness({
      async stream(_messages, options) {
        if (streaming) {
          options.onDelta('Plain ');
          options.onDelta('answer.');
        }
        return { text: 'Plain answer.', toolCalls: [] };
      },
    });
    await h.run();
    assert.deepEqual(h.final, ['Plain answer.']);
    assert.equal(h.events.some((event) => isProviderActivity(event, 'activity.reasoning.delta')), false);
  }
});

test('a failed stream preserves its partial answer without restoring earlier tool commentary', async () => {
  const h = harness({
    async stream(_messages, options) {
      options.onDelta('Inspecting the plan.');
      await options.executeTool({ id: 'tool', name: 'cuppet_plan', arguments: '{"action":"overview"}' });
      options.onDelta('Partial answer after the tool.');
      throw new Error('Connection reset');
    },
  });
  await assert.rejects(h.run(), /Connection reset/);
  assert.deepEqual(h.final, ['Partial answer after the tool.']);
  assert.deepEqual(h.events.filter((event) => isProviderActivity(event, 'activity.reasoning.delta')).map((event) => event.activity.text), ['Inspecting the plan.']);
  assert.equal(h.events.filter((event) => event.type === 'message.preview').at(-1).content, '');
});

test('live previews batch incremental text with linear payload size and clear pending timers at completion', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ready = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let send;
  const h = harness({
    async stream(_messages, { onDelta }) {
      send = onDelta;
      for (let i = 0; i < 8000; i++) onDelta('word');
      ready.resolve();
      await finish.promise;
      return { text: 'word'.repeat(8000) + ' tail end' };
    },
  });
  const running = h.run();
  await ready.promise;
  assert.equal(h.events.filter((event) => event.type === 'message.preview').length, 1, 'the first chunk is visible immediately');
  t.mock.timers.tick(50);
  const previews = h.events.filter((event) => event.type === 'message.preview');
  assert.equal(previews.length, 2);
  assert.ok(previews.reduce((bytes, event) => bytes + (event.delta ?? event.content).length, 0) <= 2 * 32000);
  const live = previews.reduce(reduceTranscriptEvent, {});
  assert.equal(live.msg_assistant.preview, 'word'.repeat(8000));
  assert.equal(previews.slice(1).reduce(reduceTranscriptEvent, {}).msg_assistant.preview, live.msg_assistant.preview, 'a view that missed the first preview can recover');
  send(' tail');
  t.mock.timers.tick(50);
  const incremental = h.events.filter((event) => event.type === 'message.preview').at(-1);
  assert.equal(incremental.delta, ' tail');
  assert.equal(incremental.seq, 32005);
  send(' end');
  finish.resolve();
  await running;
  assert.equal(h.final.join(''), 'word'.repeat(8000) + ' tail end');
  const eventCount = h.events.length;
  t.mock.timers.tick(100);
  assert.equal(h.events.length, eventCount, 'no delayed preview may appear after completion');
  const final = h.events.reduce(reduceTranscriptEvent, {});
  assert.equal(final.msg_assistant.preview, '');
});
