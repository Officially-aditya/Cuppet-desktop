import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeSseBody, splitSseEvents } from '../src/runtime/provider.mjs';

test('SSE parser preserves incomplete events across chunks', () => {
  const first = splitSseEvents('data: {"a":1}\n\ndata: {"b"');
  assert.deepEqual(first.events, ['data: {"a":1}']);
  assert.equal(first.rest, 'data: {"b"');
});

test('streaming provider emits deltas in order', async () => {
  const encoder = new TextEncoder();
  const chunks = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n',
  ];
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const deltas = [];
  const result = await consumeSseBody(body, async (delta) => deltas.push(delta));
  assert.equal(result.text, 'Hello');
  assert.deepEqual(deltas, ['Hel', 'lo']);
});
