import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeSseBody } from '../src/runtime/provider.mjs';

function streamChunks(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

test('streaming provider reconstructs fragmented OpenAI-compatible tool calls', async () => {
  const body = streamChunks([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"workspace_","arguments":"{\\"path\\":\\"src/"}}]}}]}\n',
    '\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"write","arguments":"a.js\\",\\"content\\":\\"ok\\"}"}}]}}]}\n\n',
    'data: [DO',
    'NE]\n\n',
  ]);

  const deltas = [];
  const result = await consumeSseBody(body, async (delta) => deltas.push(delta));
  assert.equal(result.text, '');
  assert.deepEqual(deltas, []);
  assert.deepEqual(result.toolCalls, [{
    id: 'call_1',
    name: 'workspace_write',
    arguments: '{"path":"src/a.js","content":"ok"}',
  }]);
});

test('streaming provider preserves ordinary text deltas alongside tool-capable parser', async () => {
  const body = streamChunks([
    'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"}}],"usage":{"prompt_tokens":3}}\n\n',
    'data: [DONE]\n\n',
  ]);
  const deltas = [];
  const result = await consumeSseBody(body, async (delta) => deltas.push(delta));
  assert.equal(result.text, 'hello');
  assert.deepEqual(deltas, ['hel', 'lo']);
  assert.deepEqual(result.toolCalls, []);
  assert.deepEqual(result.usage, { prompt_tokens: 3 });
});