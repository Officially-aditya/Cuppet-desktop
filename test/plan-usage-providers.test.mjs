import test from 'node:test';
import assert from 'node:assert/strict';
import { readProviderPlanUsage } from '../src/runtime/provider-plan-usage.mjs';
import { normalizeClaudePlanUsage, normalizeAntigravityPlanUsage, normalizeCopilotPlanUsage, usageReset } from '../src/runtime/plan-usage-normalizers.mjs';
import { requestUsageJSON } from '../src/runtime/plan-usage-http.mjs';

const reset = '2030-01-02T03:04:05.123456Z';

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

test('Claude and Antigravity usage stays in their provider apps without reading credentials', async () => {
  let credentialReads = 0, requests = 0;
  for (const providerID of ['claude-code', 'antigravity']) {
    const report = await readProviderPlanUsage(providerID, {
      readClaudeCredentials: async () => { credentialReads++; return { accessToken: 'unused' }; },
      readAntigravityCredentials: async () => { credentialReads++; return { token: 'unused' }; },
      fetchImpl: async () => { requests++; throw new Error('Cuppet must not query usage endpoints'); },
    });
    assert.equal(report.status, 'unsupported');
    assert.deepEqual(report.limits, []);
    assert.match(report.message, /Check usage in/);
  }
  assert.equal(credentialReads, 0);
  assert.equal(requests, 0);
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
