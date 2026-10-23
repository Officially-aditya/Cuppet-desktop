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

test('chat streaming rejects upstream errors and preserves already emitted text', async () => {
  for (const error of [{ message: 'upstream failed', code: 'server_error' }, 'upstream failed']) {
    const deltas = [];
    const body = new Response(`data: {"choices":[{"delta":{"content":"Partial"}}]}\n\ndata: ${JSON.stringify({ error })}\n\ndata: [DONE]\n\n`).body;
    await assert.rejects(consumeSseBody(body, async (delta) => deltas.push(delta)), /upstream failed/);
    assert.deepEqual(deltas, ['Partial']);
    assert.equal(body.locked, false);
  }
});

test('chat streaming requires completion before returning text or tool calls', async () => {
  for (const delta of [{ content: 'Partial' }, { tool_calls: [{ index: 0, id: 'call', function: { name: 'write', arguments: '{"path":' } }] }]) {
    const body = new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`).body;
    await assert.rejects(consumeSseBody(body, async () => {}), /ended before completion/);
  }
  await assert.rejects(consumeSseBody(new Response('data: [DONE]\n\n').body, async () => {}), /without text or tool calls/);
  const finished = new Response('data: {"choices":[{"delta":{"content":"Done"},"finish_reason":"stop"}]}').body;
  assert.equal((await consumeSseBody(finished, async () => {})).text, 'Done', 'finish_reason is sufficient for providers that omit [DONE]');
});

test('chat streaming reports output limits instead of completing a truncated answer', async () => {
  const deltas = [];
  const body = new Response('data: {"choices":[{"delta":{"content":"Partial"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n').body;
  await assert.rejects(consumeSseBody(body, async (delta) => deltas.push(delta)), /incomplete.*length/);
  assert.deepEqual(deltas, ['Partial']);
});

test('chat streaming handles split UTF-8 and CRLF and cancels the reader at [DONE]', async () => {
  const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hi 👋"}}]}\r\n\r\ndata: [DONE]');
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); },
  });
  assert.equal((await consumeSseBody(body, async () => {})).text, 'Hi 👋');
  const openBody = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Done"}}]}\n\ndata: [DONE]\n\n')); },
    cancel() { cancelled = true; },
  });
  assert.equal((await consumeSseBody(openBody, async () => {})).text, 'Done');
  assert.equal(cancelled, true);
  assert.equal(openBody.locked, false);
});
