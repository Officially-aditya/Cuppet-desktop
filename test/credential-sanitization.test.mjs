import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { redactCredentials, sanitizeProviderError } from '../src/runtime/credential-sanitization.mjs';
import { classifyProviderError } from '../src/runtime/provider-error.mjs';
import { providerFailureError } from '../src/runtime/providers/provider-failure.mjs';
import { RuntimeService } from '../src/runtime/service.mjs';
import { sessionProjection } from '../src/runtime/remote/session-projection.mjs';
import { publicEventFor } from '../src/runtime/remote/protocol.mjs';
import { fetchProviderModelCatalog } from '../src/main/provider-model-catalog.mjs';
import { probeCustomModel } from '../src/main/custom-models.mjs';
import { createUntrackedChatProvider } from '../src/runtime/provider-factory.mjs';

const SECRET = 'cuppet_canary_81b3c90e2974cd65';

test('credentials are removed from JSON, headers, URLs and echoed error text', () => {
  for (const value of [
    JSON.stringify({ api_key: SECRET, access_token: SECRET, refresh_token: SECRET }),
    JSON.stringify({ message: JSON.stringify({ response: { access_token: SECRET, refresh_token: SECRET } }) }),
    `{'access_token':'${SECRET}'}`,
    `{"access\\u005ftoken":"${SECRET}"}`,
    `{"message":"provider failed", "token":"${SECRET}`,
    `x-api-key: ${SECRET}`, `X-Goog-Api-Key=${SECRET}`,
    `AWS_SESSION_TOKEN=${SECRET}`, `X-Secret-Key: ${SECRET}`, `X-Token: ${SECRET}`,
    `private_key="${SECRET}"`, JSON.stringify({ private_key: SECRET }),
    `-----BEGIN PRIVATE KEY-----\n${SECRET}\n-----END PRIVATE KEY-----`,
    `Invalid credential supplied: ${SECRET}`, `API key provided: ${SECRET}`,
    `Authorization: Bearer ${SECRET}`, `Basic ${SECRET}`,
    `Cookie: first=${SECRET}; second=${SECRET}; third=${SECRET}`,
    `Set-Cookie: first=${SECRET}; HttpOnly; Path=/`,
    `https://provider.example/v1?key=${SECRET}&model=valid`,
    `https://provider.example/?access%5Ftoken=${SECRET}`,
    `https://user:${SECRET}@provider.example/v1`,
  ]) {
    const result = redactCredentials(value);
    assert.ok(!result.includes(SECRET), 'credential survived sanitization');
    assert.equal(redactCredentials(result), result, 'redaction must be idempotent');
    assert.ok(result.includes('[redacted]'));
  }
  assert.equal(redactCredentials('401 invalid api key; retry model gpt-test'), '401 invalid api key; retry model gpt-test');
});

test('opaque known credentials and their encoded forms are removed without hiding safe model settings', () => {
  const secret = 'opaque-key@host:a+b/c\\"value';
  const context = { apiKey: secret };
  for (const value of [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]) {
    assert.equal(redactCredentials(`upstream returned ${value}`, context), 'upstream returned [redacted]');
  }
  assert.equal(redactCredentials('max_tokens=1000 input_tokens=32 model=test-model'), 'max_tokens=1000 input_tokens=32 model=test-model');
  const shared = 'shared-credential-prefix-';
  assert.equal(redactCredentials(shared + 'second', { apiKey: shared + 'first1', cliEnv: { OTHER_API_KEY: shared + 'second' } }), '[redacted]');
  assert.equal(classifyProviderError(new Error('401 unauthorized'), { provider: { apiKey: '401', providerID: 'openai' } }).category, 'authentication');
});

test('sanitized errors retain abort, retry and transport metadata without retaining raw causes or stacks', () => {
  const cause = Object.assign(new Error(`upstream echoed ${SECRET}`), { code: 'ECONNRESET' });
  const error = providerFailureError('process stopped', { code: 'PROVIDER_PROCESS_EXITED', category: 'process_exited', retryable: true, diagnostic: `upstream echoed ${SECRET}`, cause });
  const result = sanitizeProviderError(error, { apiKey: SECRET });
  assert.equal(result.code, error.code);
  assert.equal(result.providerFailure.category, 'process_exited');
  assert.equal(result.providerFailure.retryable, true);
  assert.equal(result.cause.code, 'ECONNRESET');
  for (const value of [result.message, result.stack, result.providerFailure.diagnostic, result.cause.message, result.cause.stack]) assert.ok(!value.includes(SECRET));
  assert.ok(error.providerFailure.diagnostic.includes(SECRET), 'the caller-owned error is not mutated');
  assert.equal(sanitizeProviderError(Object.assign(new Error('stopped'), { name: 'AbortError' })).name, 'AbortError');
});

test('known credentials stay redacted when provider diagnostics were already truncated', () => {
  const key = 'opaque-' + '0123456789abcdef'.repeat(500);
  const error = providerFailureError('provider exited', { category: 'process_exited', diagnostic: `subprocess echoed ${key}` });
  const failure = classifyProviderError(error, { provider: { providerID: 'openai-compatible', apiKey: key } });
  assert.ok(!JSON.stringify(failure).includes(key.slice(0, 80)));
  assert.ok(failure.diagnostic.includes('[redacted]'));
  const tail = redactCredentials(key.slice(-100), { apiKey: key });
  assert.ok(!tail.includes('0123456789abcdef'));
  const escapedKey = 'opaque-12345678901234567890"\\' + 'sensitive-content'.repeat(40);
  const partialJson = JSON.stringify({ message: `upstream echoed ${escapedKey}` }).slice(0, 200);
  const redacted = redactCredentials(partialJson, { apiKey: escapedKey });
  assert.ok(!redacted.includes('sensitive-content'));
});

test('provider errors cannot persist or reach desktop/remote events with an echoed execution key', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-credential-events-'));
  const events = [];
  const runtime = new RuntimeService({ databasePath: join(dir, 'db.sqlite3'), emit: event => events.push(event),
    providerFactory: () => ({ async stream() { throw providerFailureError('process exited', { category: 'process_exited', diagnostic: `provider echoed ${SECRET}` }); } }),
  });
  t.after(async () => { await runtime.close(); await rm(dir, { recursive: true, force: true }); });
  const session = await runtime.handle('session.create');
  await runtime.handle('session.send', { sessionId: session.id, text: 'synthetic test', provider: { providerID: 'openai-compatible', apiKey: SECRET, model: 'test-model' } });
  const deadline = Date.now() + 3000;
  while (!events.some(event => event.type === 'run.finished') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(events.some(event => event.type === 'run.finished'));
  const restored = await runtime.handle('session.get', { sessionId: session.id });
  assert.equal(restored.messages.at(-1).status, 'error');
  const failure = events.find(event => event.type === 'runtime.error');
  for (const value of [events, restored, sessionProjection(restored), publicEventFor(failure)]) {
    assert.ok(!JSON.stringify(value).includes(SECRET), 'credential crossed the history or renderer/remote boundary');
  }
  assert.equal(failure.providerError.category, 'streaming');
  assert.equal(failure.providerError.action, 'retry');
});

test('generation, discovery and model probes redact before diagnostic truncation', async () => {
  const secret = `opaque-${'0123456789abcdef'.repeat(160)}`;
  const configuration = { providerID: 'openai-compatible', model: 'test-model', apiKey: secret, baseUrl: 'https://credential-test.example/v1' };
  const fetchImpl = async () => new Response(JSON.stringify({ error: { message: `upstream echoed ${secret}` } }), { status: 401, headers: { 'content-type': 'application/json' } });
  const provider = createUntrackedChatProvider({ ...configuration, fetchImpl });
  await assert.rejects(provider.stream([{ role: 'user', content: 'hello' }], { onDelta() {} }), error => {
    assert.ok(!error.message.includes(secret.slice(0, 80)));
    assert.match(error.message, /401/);
    return true;
  });
  const catalog = await fetchProviderModelCatalog(configuration, { fetchImpl, refresh: true });
  assert.ok(!JSON.stringify(catalog).includes(secret.slice(0, 80)));
  assert.equal(catalog.available, false);
  await assert.rejects(probeCustomModel(configuration, 'test-model', { providerFactory: () => ({ async stream() { throw new Error(`upstream echoed ${secret}`); } }) }), error => {
    assert.ok(!error.message.includes(secret.slice(0, 80)));
    assert.match(error.message, /Custom model test failed/);
    return true;
  });
});
