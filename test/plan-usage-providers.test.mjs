import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readProviderPlanUsage } from '../src/runtime/provider-plan-usage.mjs';
import { readClaudeCredentials, readAntigravityCredentials } from '../src/runtime/provider-plan-usage-readers.mjs';
import { normalizeClaudePlanUsage, normalizeAntigravityPlanUsage, normalizeCopilotPlanUsage, usageReset } from '../src/runtime/plan-usage-normalizers.mjs';
import { requestUsageJSON } from '../src/runtime/plan-usage-http.mjs';

const reset = '2030-01-02T03:04:05.123456Z';
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const missing = () => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); };

test('Claude windows retain model-specific weekly limits and never infer missing telemetry', () => {
  const report = normalizeClaudePlanUsage({
    five_hour: { utilization: -10, resets_at: 'bad' },
    seven_day: { utilization: 120, resets_at: reset },
    seven_day_sonnet: { utilization: 42.5, resets_at: null },
    seven_day_opus: { utilization: 0 },
    extra_usage: { utilization: 70 }, access_token: 'private-secret',
  }, { fetchedAt: 123, planType: 'max' });
  assert.equal(report.fetchedAt, 123);
  assert.deepEqual(report.limits[0].windows.map(w => w.remainingPercent), [100, 0, 57.5, 100]);
  assert.equal(report.limits[0].windows[2].label, 'Weekly limit · sonnet');
  assert.equal(report.limits[0].windows[0].resetsAt, null);
  assert.equal(report.limits[0].windows[1].resetsAt, Date.parse(reset));
  assert.doesNotMatch(JSON.stringify(report), /private-secret|extra_usage/);
  for (const value of [null, [], {}, { five_hour: [] }, ...[null, '0', NaN, Infinity, {}].map(utilization => ({ seven_day: { utilization } }))]) {
    assert.equal(normalizeClaudePlanUsage(value).status, 'unavailable');
  }
});

test('Antigravity handles grouped, flat and older model quotas without duplicating windows', () => {
  const bucket = (id, fraction, duration = 'weekly') => ({ bucketId: id, remainingFraction: fraction, window: duration, resetTime: reset });
  const grouped = normalizeAntigravityPlanUsage({
    groups: [{ displayName: 'Gemini', buckets: [bucket('w', 0), bucket('h', 1, '5h'), bucket('w', 0.3), { ...bucket('disabled', 0.4), disabled: true }] }],
    buckets: [bucket('legacy', 0.5)],
  });
  assert.equal(grouped.limits.length, 1);
  assert.deepEqual(grouped.limits[0].windows.map(w => [w.label, w.remainingPercent]), [['Weekly limit', 0], ['5-hour limit', 100]]);
  const flat = normalizeAntigravityPlanUsage({ buckets: [bucket('flat', -1), bucket('next', 2, 'daily')] });
  assert.deepEqual(flat.limits.map(l => l.windows[0].usedPercent), [100, 0]);
  const models = normalizeAntigravityPlanUsage({ models: {
    flash: { displayName: 'Gemini Flash', quotaInfo: { remainingFraction: 0.25, resetTime: reset } },
    unreported: {}, malformed: { quotaInfo: { remainingFraction: '0' } },
  } });
  assert.equal(models.limits.length, 1);
  assert.equal(models.limits[0].label, 'Gemini Flash');
  assert.equal(models.limits[0].windows[0].remainingPercent, 25);
  assert.equal(models.limits[0].windows[0].windowDurationMins, null);
  for (const value of [null, [], {}, { groups: [null, { buckets: [null, {}, { remainingFraction: null }, { remainingFraction: Infinity }] }] }, { models: [] }]) {
    assert.equal(normalizeAntigravityPlanUsage(value).status, 'unavailable');
  }
});

test('Copilot preserves monthly credits, request quantities, unlimited and zero-sized entitlements', () => {
  const report = normalizeCopilotPlanUsage({ quotaSnapshots: {
    ai_credits: { usedRequests: 20.5, entitlementRequests: 100, remainingPercentage: 79.5, resetDate: '2030-02-01' },
    premium_interactions: { usedRequests: 400, entitlementRequests: 300 },
    chat: { entitlementRequests: -1, usedRequests: 0, remainingPercentage: 0 },
    completions: { entitlementRequests: 0, usedRequests: 0, remainingPercentage: 0 },
  } });
  assert.equal(report.limits[0].label, 'AI credits');
  assert.equal(report.limits[0].windows[0].remainingPercent, 79.5);
  assert.equal(report.limits[0].windows[0].resetsAt, Date.parse('2030-02-01T00:00:00Z'));
  assert.match(report.limits[0].detail, /20.5 of 100/);
  assert.equal(report.limits[1].windows[0].remainingPercent, 0);
  assert.match(report.limits[2].detail, /Unlimited/);
  assert.deepEqual(report.limits[2].windows, []);
  assert.equal(report.limits[3].detail, '0 of 0 used this period');
  assert.deepEqual(report.limits[3].windows, []);
  for (const quota of [null, [], {}, { remainingPercentage: null }, { remainingPercentage: '0' }, { usedRequests: 0 }, { entitlementRequests: 100 }, { usedRequests: -2, entitlementRequests: -2 }]) {
    assert.equal(normalizeCopilotPlanUsage({ quotaSnapshots: { test: quota } }).status, 'unavailable');
  }
  for (const key of ['constructor', '__proto__', 'toString']) {
    const report = normalizeCopilotPlanUsage({ quotaSnapshots: { [key]: { remainingPercentage: 40 } } });
    assert.equal(typeof report.limits[0].label, 'string');
  }
});

test('invalid, locale-dependent, and missing reset dates remain unknown', () => {
  for (const value of [null, undefined, '', '0', 'Jan 1 2030', '2030-01-01T00:00:00', '2030-99-99T00:00:00Z', '2030-02-30', '2030-02-30T03:00:00Z', '2030-01-01T24:00:00Z', 2000000000, Infinity]) {
    assert.equal(usageReset(value), null, String(value));
  }
  assert.equal(usageReset('2030-01-01T01:00:00+01:00'), Date.parse('2030-01-01T00:00:00Z'));
});

test('Claude credentials respect environment and profile-scoped storage without cross-account fallback', async () => {
  assert.equal((await readClaudeCredentials({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'env-token' }, readFileImpl: missing })).accessToken, 'env-token');
  let path, service;
  const profile = '/test/profile';
  const file = await readClaudeCredentials({
    env: { CLAUDE_CONFIG_DIR: profile, USER: 'test-user' }, home: '/test/home', platform: 'darwin',
    runCommand: async (command, args, timeout, options) => {
      assert.equal(command, '/usr/bin/security');
      assert.equal(timeout, 4000);
      assert.equal(options.stdin, 'ignore');
      service = args.at(-1);
      throw new Error('keychain unavailable');
    },
    readFileImpl: async p => { path = p; return JSON.stringify({ claudeAiOauth: { accessToken: 'file-token' } }); },
  });
  assert.equal(file.accessToken, 'file-token');
  assert.equal(path, profile + '/.credentials.json');
  assert.equal(service, 'Claude Code-credentials-' + createHash('sha256').update(profile).digest('hex').slice(0, 8));
  const keychain = await readClaudeCredentials({
    env: { USER: 'test-user' }, home: '/test/home', platform: 'darwin',
    runCommand: async () => ({ stdout: '{"claudeAiOauth":{"accessToken":"keychain-token"}}' }),
    readFileImpl: () => { throw new Error('file store must not override keychain'); },
  });
  assert.equal(keychain.accessToken, 'keychain-token');
  assert.equal(await readClaudeCredentials({ env: {}, platform: 'linux', readFileImpl: missing }), null);
  await assert.rejects(readClaudeCredentials({ env: {}, platform: 'linux', readFileImpl: async () => '{"accessToken":"private-token"' }), error => {
    assert.doesNotMatch(error.message, /private-token/); return true;
  });
  await assert.rejects(readClaudeCredentials({ env: {}, platform: 'linux', readFileImpl: async () => { throw Object.assign(new Error('private-token'), { code: 'EACCES' }); } }), /Could not read Claude Code sign-in/);
});

test('Antigravity reads the same home and file store as its Cuppet ACP adapter', async () => {
  let path;
  const credentials = await readAntigravityCredentials({
    env: {}, home: '/test/home', configuration: { cliEnv: { GEMINI_HOME: '~/custom-gemini' } },
    readFileImpl: async p => { path = p; return '{"client_id":"client","refresh_token":"secret"}'; },
  });
  assert.equal(path, '/test/home/custom-gemini/antigravity-acp/acp_token.json');
  assert.equal(credentials.client_id, 'client');
  assert.equal(await readAntigravityCredentials({ env: {}, readFileImpl: missing }), null);
});

test('expired and restricted Claude tokens do not call a usage endpoint or refresh credentials', async () => {
  for (const credentials of [{ accessToken: 'secret', expiresAt: 1 }, { accessToken: 'secret', scopes: ['user:inference'] }]) {
    const report = await readProviderPlanUsage('claude-code', {
      readClaudeCredentials: async () => credentials,
      fetchImpl: async () => { throw new Error('must not request'); },
    });
    assert.equal(report.status, 'signed-out');
    assert.deepEqual(report.limits, []);
    assert.doesNotMatch(report.message, /secret/);
  }
});

test('Antigravity falls back on older quota endpoints, selects enterprise endpoint and uses existing access tokens', async () => {
  const calls = [];
  const report = await readProviderPlanUsage('antigravity', {
    readAntigravityCredentials: async () => ({ token: 'existing-access', expiry: '2035-01-01T00:00:00Z', token_uri: 'https://untrusted.invalid/token' }),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith(':loadCodeAssist')) return json({ paidTier: { usesGcpTos: true, name: 'Enterprise' }, cloudaicompanionProject: 'enterprise-project' });
      if (url.endsWith(':retrieveUserQuotaSummary')) return json({}, 404);
      return json({ models: { pro: { displayName: 'Gemini Pro', quotaInfo: { remainingFraction: 0.2 } } } });
    },
  });
  assert.equal(report.status, 'available');
  assert.equal(report.planType, 'Enterprise');
  assert.equal(report.limits[0].windows[0].remainingPercent, 20);
  assert.ok(calls.every(c => c.url.startsWith('https://cloudcode-pa.googleapis.com/')));
  assert.equal(calls.length, 3);
});

test('Antigravity never onboards accounts or disguises failed quota reads as a valid allowance', async () => {
  const credentials = { refresh_token: 'google-secret', client_id: 'client', client_secret: 'secret', token_uri: 'https://untrusted.invalid/token' };
  for (const status of [400, 401, 403, 429, 500]) {
    let calls = 0;
    const report = await readProviderPlanUsage('antigravity', {
      readAntigravityCredentials: async () => credentials,
      fetchImpl: async url => { calls++; assert.equal(url, 'https://oauth2.googleapis.com/token'); return json({ error: 'google-secret' }, status); },
    });
    assert.equal(report.status, [400, 401, 403].includes(status) ? 'signed-out' : 'error');
    assert.equal(calls, 1);
    assert.deepEqual(report.limits, []);
    assert.doesNotMatch(report.message, /google-secret/);
  }
  const calls = [];
  const report = await readProviderPlanUsage('antigravity', {
    readAntigravityCredentials: async () => credentials,
    fetchImpl: async url => { calls.push(url); return json(url.includes('/token') ? { access_token: 'access' } : {}); },
  });
  assert.equal(report.status, 'unavailable');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(url => !url.includes('onboardUser')));
});

test('Copilot closes clients after every failure and never authenticates or queries quotas while signed out', async () => {
  for (const failAt of ['start', 'auth.getStatus', 'account.getQuota', 'signed-out', 'unsupported']) {
    const methods = [];
    let closes = 0;
    const report = await readProviderPlanUsage('github-copilot', {
      env: { PATH: '' },
      resolveCopilotRuntime: async () => ({ command: 'fake-copilot' }),
      createCopilotClient: () => ({
        async start() { if (failAt === 'start') throw new Error('Authorization: Bearer private-secret'); },
        async request(method) {
          methods.push(method);
          if (method === failAt) throw new Error('Authorization: Bearer private-secret');
          if (method === 'auth.getStatus') return { isAuthenticated: failAt !== 'signed-out' };
          if (failAt === 'unsupported') throw Object.assign(new Error('missing method'), { code: -32601 });
          return {};
        },
        async close() { closes++; throw new Error('already closed'); },
      }),
    });
    assert.equal(closes, 1);
    assert.equal(report.status, failAt === 'signed-out' ? 'signed-out' : failAt === 'unsupported' ? 'unavailable' : 'error');
    assert.ok(methods.every(m => ['auth.getStatus', 'account.getQuota'].includes(m)));
    if (failAt === 'signed-out') assert.deepEqual(methods, ['auth.getStatus']);
    assert.doesNotMatch(report.message, /private-secret/);
  }
  const absent = await readProviderPlanUsage('github-copilot', { resolveCopilotRuntime: async () => null });
  assert.equal(absent.status, 'unavailable');
});

test('usage HTTP transport bounds report size, rejects invalid JSON and returns safe network and timeout errors', async () => {
  const cases = [
    async () => new Response('private-invalid-json'),
    async () => new Response('private-oversized', { headers: { 'content-length': '999999999' } }),
    async () => new Response('x'.repeat(1024 * 1024 + 1)),
    async () => { throw new Error('Authorization: Bearer private-token'); },
  ];
  for (const fetchImpl of cases) await assert.rejects(requestUsageJSON('https://test.invalid', { fetchImpl }), error => {
    assert.doesNotMatch(error.message, /private-/); return true;
  });
  await assert.rejects(requestUsageJSON('https://test.invalid', {
    timeoutMs: 10, fetchImpl: async (url, { signal }) => new Promise((_, reject) => {
      const keepAlive = setTimeout(() => reject(new Error('timeout was not enforced')), 1000);
      signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(signal.reason); }, { once: true });
    }),
  }), /timed out/);
});

test('unsupported provider IDs including object prototype names never dispatch a reader', async () => {
  for (const providerID of ['constructor', '__proto__', 'toString', 'api-provider']) {
    const report = await readProviderPlanUsage(providerID, { env: { TEST_SECRET: 'private-env-token' } });
    assert.equal(report.status, 'unsupported');
    assert.doesNotMatch(JSON.stringify(report), /private-env-token/);
  }
});
