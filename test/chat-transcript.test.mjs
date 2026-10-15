import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reduceTranscriptEvent,
  orderedTranscriptItems,
  formatWorkedDuration,
  hydrateTranscript,
  mergeTranscriptState,
} from '../src/renderer/react/chat-transcript.ts';

test('provider retries render as status entries without contaminating reasoning or duplicating hydrated events', () => {
  const event = { type: 'runtime.activity', source: 'provider', messageId: 'retry-message', sequence: 1,
    activity: { type: 'activity.warning', code: 'provider_retry', message: 'OpenCode is retrying the request (attempt 1). Endpoint is unavailable' } };
  let state = reduceTranscriptEvent({}, event);
  state = reduceTranscriptEvent(state, event);
  const items = state['retry-message'].items;
  assert.equal(items.length, 1);
  assert.equal(items[0].type, 'status');
  assert.match(items[0].text, /attempt 1/);
  state = reduceTranscriptEvent(state, { ...event, sequence: 2, activity: { type: 'activity.reasoning.delta', text: 'Continuing.' } });
  assert.deepEqual(state['retry-message'].items.map(item => item.type), ['status', 'reasoning']);
});

test('chat-transcript accepts and merges provider tool activities', () => {
  let state = {};

  // Provider emits tool opened
  state = reduceTranscriptEvent(state, {
    type: 'runtime.activity',
    source: 'provider',
    messageId: 'msg-1',
    sequence: 1,
    activity: {
      type: 'activity.tool.opened',
      callId: 'call_glob_1',
      tool: 'glob',
      label: 'glob',
      argumentsJson: '{}',
    },
  });

  let items = orderedTranscriptItems(state['msg-1']?.items);
  assert.equal(items.length, 1);
  assert.equal(items[0].type, 'tool');
  assert.equal(items[0].tool, 'glob');
  assert.equal(items[0].status, 'running');

  // Provider emits tool updated with arguments
  state = reduceTranscriptEvent(state, {
    type: 'runtime.activity',
    source: 'provider',
    messageId: 'msg-1',
    sequence: 2,
    activity: {
      type: 'activity.tool.updated',
      callId: 'call_glob_1',
      tool: 'glob',
      argumentsJson: '{"pattern":"**/*.ts"}',
    },
  });

  items = orderedTranscriptItems(state['msg-1']?.items);
  assert.equal(items.length, 1);
  assert.equal(items[0].argumentsJson, '{"pattern":"**/*.ts"}');

  // Provider emits tool closed
  state = reduceTranscriptEvent(state, {
    type: 'runtime.activity',
    source: 'provider',
    messageId: 'msg-1',
    sequence: 3,
    activity: {
      type: 'activity.tool.closed',
      callId: 'call_glob_1',
      tool: 'glob',
      argumentsJson: '{}',
      details: 'src/index.ts',
      status: 'success',
    },
  });

  items = orderedTranscriptItems(state['msg-1']?.items);
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'complete');
  assert.equal(items[0].argumentsJson, '{"pattern":"**/*.ts"}', 'Arguments should be preserved when closed update has empty object');
  assert.equal(items[0].details, 'src/index.ts');
});

test('chat-transcript merges execution MCP tool into running provider tool without duplicating', () => {
  let state = {};

  // Provider emits tool opened for MCP tool
  state = reduceTranscriptEvent(state, {
    type: 'runtime.activity',
    source: 'provider',
    messageId: 'msg-2',
    sequence: 1,
    activity: {
      type: 'activity.tool.opened',
      callId: 'call_tst_1',
      tool: 'tst_explore',
      label: 'tst_explore',
      argumentsJson: '{"query":"model"}',
    },
  });

  let items = orderedTranscriptItems(state['msg-2']?.items);
  assert.equal(items.length, 1);
  assert.equal(items[0].tool, 'tst_explore');
  assert.equal(items[0].status, 'running');

  // Execution emits tool.started for the same MCP tool call
  state = reduceTranscriptEvent(state, {
    type: 'runtime.activity',
    source: 'execution',
    messageId: 'msg-2',
    sequence: 2,
    activity: {
      type: 'activity.tool.opened',
      callId: 'mcp_opencode_session_1',
      tool: 'tst_explore',
      argumentsJson: '{"query":"model"}',
    },
  });

  items = orderedTranscriptItems(state['msg-2']?.items);
  assert.equal(items.length, 1, 'Should not create duplicate tool item for MCP execution');

  // Execution finishes with output
  state = reduceTranscriptEvent(state, {
    type: 'runtime.activity',
    source: 'execution',
    messageId: 'msg-2',
    sequence: 3,
    activity: {
      type: 'activity.tool.closed',
      callId: 'mcp_opencode_session_1',
      tool: 'tst_explore',
      details: 'Graph output',
      status: 'success',
    },
  });

  items = orderedTranscriptItems(state['msg-2']?.items);
  assert.equal(items.length, 1);
  assert.equal(items[0].details, 'Graph output');
  assert.equal(items[0].status, 'complete');
});

test('reasoning deltas preserve whitespace and concatenate naturally', () => {
  let state = {};

  const deltas = ['The', ' user asks what', "'s", ' inside hello.txt. Let me', ' check.'];
  for (let i = 0; i < deltas.length; i++) {
    state = reduceTranscriptEvent(state, {
      type: 'runtime.activity',
      source: 'provider',
      messageId: 'msg-3',
      sequence: i + 1,
      activity: {
        type: 'activity.reasoning.delta',
        text: deltas[i],
      },
    });
  }

  const items = orderedTranscriptItems(state['msg-3']?.items);
  assert.equal(items.length, 1);
  assert.equal(items[0].type, 'reasoning');
  assert.equal(items[0].text, "The user asks what's inside hello.txt. Let me check.");
});

test('formatWorkedDuration uses seconds below a minute and two units for longer durations', () => {
  // Seconds
  assert.equal(formatWorkedDuration(400), '1s');
  assert.equal(formatWorkedDuration(1000), '1s');
  assert.equal(formatWorkedDuration(12000), '12s');
  assert.equal(formatWorkedDuration(25000), '25s');
  assert.equal(formatWorkedDuration(28785), '29s');
  assert.equal(formatWorkedDuration(50000), '50s');
  assert.equal(formatWorkedDuration(59000), '59s');
  assert.equal(formatWorkedDuration(59999), '1m 0s');

  // Minutes
  assert.equal(formatWorkedDuration(60000), '1m 0s');
  assert.equal(formatWorkedDuration(85000), '1m 25s');
  assert.equal(formatWorkedDuration(103591), '1m 44s');
  assert.equal(formatWorkedDuration(136555), '2m 17s');
  assert.equal(formatWorkedDuration(154409), '2m 34s');
  assert.equal(formatWorkedDuration(261000), '4m 21s');
  assert.equal(formatWorkedDuration(270000), '4m 30s');
  assert.equal(formatWorkedDuration(3540000), '59m 0s');
  assert.equal(formatWorkedDuration(3599000), '59m 59s');
  assert.equal(formatWorkedDuration(3599999), '1h 0m');

  // Hours
  assert.equal(formatWorkedDuration(3600000), '1h 0m');
  assert.equal(formatWorkedDuration(7200000), '2h 0m');
  assert.equal(formatWorkedDuration(19200000), '5h 20m');
  assert.equal(formatWorkedDuration(86400000), '24h 0m');
});

test('thought timing ends at the next tool or answer and survives history hydration', () => {
  const rows = [
    { messageId: 'timed', source: 'provider', sequence: 1, createdAt: 1000, activity: { type: 'activity.reasoning.delta', text: 'First thought.' } },
    { messageId: 'timed', source: 'provider', sequence: 2, createdAt: 3000, activity: { type: 'activity.tool.opened', callId: 'read', tool: 'read' } },
    { messageId: 'timed', source: 'provider', sequence: 3, createdAt: 5000, activity: { type: 'activity.reasoning.delta', text: 'Second thought.' } },
    { messageId: 'timed', source: 'provider', sequence: 4, createdAt: 9000, activity: { type: 'activity.text.delta', text: 'Final answer.' } },
  ];
  const state = hydrateTranscript(rows);
  const thoughts = state.timed.items.filter((item) => item.type === 'reasoning');
  assert.deepEqual(thoughts.map(({ startedAt, completedAt }) => [startedAt, completedAt]), [[1000, 3000], [5000, 9000]]);
  assert.deepEqual(state.timed.items.map((item) => item.type), ['reasoning', 'tool', 'reasoning']);
  assert.equal(state.timed.preview, '');
});

test('a live answer closes thought timing without losing it when older history is merged', () => {
  const durable = hydrateTranscript([{ messageId: 'live-timing', source: 'provider', sequence: 1, createdAt: 1000,
    activity: { type: 'activity.reasoning.delta', text: 'Inspecting.' } }]);
  const live = reduceTranscriptEvent(durable, { type: 'message.preview', messageId: 'live-timing', content: 'Answer', createdAt: 6000 });
  assert.equal(live['live-timing'].items[0].completedAt, 6000);
  assert.equal(mergeTranscriptState(live, durable)['live-timing'].items[0].completedAt, 6000);
  const stopped = reduceTranscriptEvent(durable, { type: 'message.completed', messageId: 'live-timing', createdAt: 8000 });
  assert.equal(stopped['live-timing'].items[0].completedAt, 8000);
});

test('progress narration stays separate from provider reasoning and retains its measured interval', () => {
  const state = hydrateTranscript([
    { messageId: 'progress', source: 'provider', sequence: 1, createdAt: 1000, activity: { type: 'activity.reasoning.delta', text: 'Thinking.' } },
    { messageId: 'progress', source: 'provider', sequence: 2, createdAt: 5000,
      activity: { type: 'activity.reasoning.delta', kind: 'commentary', text: 'Checking a file.', startedAt: 2000, completedAt: 5000 } },
  ]);
  const items = state.progress.items;
  assert.equal(items.length, 2);
  assert.equal(items[0].text, 'Thinking.');
  assert.equal(items[1].kind, 'commentary');
  assert.equal(items[1].startedAt, 2000);
  assert.equal(items[1].completedAt, 5000);
});

