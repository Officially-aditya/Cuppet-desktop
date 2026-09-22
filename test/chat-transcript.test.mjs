import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reduceTranscriptEvent,
  orderedTranscriptItems,
} from '../src/renderer/react/chat-transcript.ts';

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
