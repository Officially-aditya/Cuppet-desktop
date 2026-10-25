import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { fetchProvider } from '../src/runtime/provider-fetch.mjs';
import { AnthropicMessagesProvider, GeminiInteractionsProvider } from '../src/runtime/native-provider.mjs';
import { discoverApiCapabilities } from '../src/runtime/providers/backends/api.mjs';

const KEY = 'cuppet_redirect_canary_97deed165a0f';

test('same-origin provider redirects retain request headers, body, streaming and cancellation', async () => {
  const signal = new AbortController().signal;
  const calls = [];
  const streamed = new Response('data: hello\n\n', { headers: { 'content-type': 'text/event-stream' } });
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1 ? new Response(null, { status: 307, headers: { location: '/v1/messages/' } }) : streamed;
  };
  const result = await fetchProvider(fetchImpl, 'https://api.example/v1/messages', { method: 'POST', headers: { 'x-api-key': KEY }, body: '{"model":"test"}', signal });
  assert.equal(result, streamed);
  assert.equal(calls[1].url, 'https://api.example/v1/messages/');
  assert.equal(calls[1].init.headers['x-api-key'], KEY);
  assert.equal(calls[1].init.body, '{"model":"test"}');
  assert.equal(calls[1].init.signal, signal);
  assert.equal(calls[1].init.redirect, 'manual');
  assert.equal(await result.text(), 'data: hello\n\n');
});

test('safe redirects preserve Fetch method rewriting and stop redirect loops', async () => {
  let requests = 0;
  const response = await fetchProvider(async (_url, init) => {
    if (++requests === 1) return new Response(null, { status: 303, headers: { location: '/result' } });
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    assert.equal(init.headers.get('content-type'), null);
    assert.equal(init.headers.get('x-api-key'), KEY);
    return new Response('OK');
  }, 'https://api.example/start', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', 'x-api-key': KEY } });
  assert.equal(await response.text(), 'OK');
  let loops = 0;
  await assert.rejects(fetchProvider(async () => { loops++; return new Response(null, { status: 307, headers: { location: '/loop' } }); }, 'https://api.example/loop'), /redirect limit/);
  assert.equal(loops, 21);
});

test('provider generation and discovery never forward API keys across origins', async (t) => {
  let credentialRequests = 0;
  let redirectedRequests = 0;
  const target = createServer((_request, response) => { redirectedRequests++; response.end('unexpected'); });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  const source = createServer((request, response) => {
    if (request.headers['x-api-key'] === KEY || request.headers['x-goog-api-key'] === KEY) credentialRequests++;
    response.writeHead(307, { location: `http://127.0.0.1:${target.address().port}/other` }); response.end();
  });
  await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    source.closeAllConnections(); target.closeAllConnections();
    await Promise.all([new Promise(resolve => source.close(resolve)), new Promise(resolve => target.close(resolve))]);
  });
  const baseUrl = `http://127.0.0.1:${source.address().port}`;
  for (const [providerID, Provider] of [['anthropic', AnthropicMessagesProvider], ['google', GeminiInteractionsProvider]]) {
    const configuration = { providerID, apiKey: KEY, model: 'test-model', baseUrl, requestHeaders: {}, requestBody: {} };
    await assert.rejects(new Provider(configuration).stream([{ role: 'user', content: 'hello' }]), /redirect to another origin/);
    await assert.rejects(discoverApiCapabilities({ configuration }), /redirect to another origin/);
  }
  assert.equal(credentialRequests, 4, 'authentication must still reach the configured provider');
  assert.equal(redirectedRequests, 0, 'no request may reach the untrusted redirect target');
});

test('redirect rejection hides URL credentials while retaining actionable configuration errors', async () => {
  const errorResponse = () => new Response(null, { status: 307, headers: { location: `http://other.example/?key=${KEY}` } });
  await assert.rejects(fetchProvider(errorResponse, 'https://api.example/request', { headers: { 'x-api-key': KEY } }), error => {
    assert.equal(error.name, 'ProviderConfigurationError');
    assert.ok(!error.message.includes(KEY));
    return true;
  });
});
