import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatibleChatProvider, consumeSseBody, splitSseEvents } from '../src/runtime/provider.mjs';

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
  const body = new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); } });
  const deltas = [];
  const result = await consumeSseBody(body, async (delta) => deltas.push(delta));
  assert.equal(result.text, 'Hello');
  assert.deepEqual(deltas, ['Hel', 'lo']);
});

test('provider adapter applies sanitized effort request metadata while auth and prompt fields remain authoritative', async () => {
  let request;
  const provider = new OpenAICompatibleChatProvider({
    apiKey: 'real-key', baseUrl: 'https://api.example.test/v1', model: 'transport-model',
    requestHeaders: { 'x-effort': 'high', authorization: 'variant-secret', cookie: 'variant-cookie' },
    requestBody: { reasoning: { effort: 'high' }, model: 'wrong-model', messages: [{ role: 'user', content: 'wrong' }], stream: false },
    fetchImpl: async (_url, init) => {
      request = init;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const messages = [{ role: 'user', content: 'real prompt' }];
  await provider.stream(messages, { onDelta: async () => {} });
  const body = JSON.parse(request.body);
  assert.equal(request.headers.authorization, 'Bearer real-key');
  assert.equal(request.headers['x-effort'], 'high');
  assert.equal(request.headers.cookie, undefined);
  assert.equal(body.model, 'transport-model');
  assert.deepEqual(body.messages, messages);
  assert.equal(body.stream, true);
  assert.deepEqual(body.reasoning, { effort: 'high' });
});
