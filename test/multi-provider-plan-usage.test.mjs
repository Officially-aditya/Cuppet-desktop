import test from 'node:test';
import assert from 'node:assert/strict';
import { readProviderPlanUsage } from '../src/runtime/provider-plan-usage.mjs';

const reset = '2030-01-02T03:04:05Z';
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const noCredentials = async () => null;

test('Claude plan usage reads the authenticated account, including session and weekly limits', async () => {
  const calls = [];
  const report = await readProviderPlanUsage('claude-code', {
    readClaudeCredentials: async () => ({ accessToken: 'claude-test-secret', subscriptionType: 'max' }),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return json({ five_hour: { utilization: 0, resets_at: reset }, seven_day: { utilization: 100, resets_at: reset } });
    },
  });
  assert.equal(report.status, 'available');
  assert.equal(report.providerID, 'claude-code');
  assert.equal(report.planType, 'max');
  assert.equal(report.limits[0].windows[0].remainingPercent, 100);
  assert.equal(report.limits[0].windows[1].remainingPercent, 0);
  assert.equal(report.limits[0].windows[1].resetsAt, Date.parse(reset));
  assert.equal(calls[0].url, 'https://api.anthropic.com/api/oauth/usage');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer claude-test-secret');
  assert.equal(calls[0].options.redirect, 'error');
  assert.ok(calls[0].options.signal);
  assert.doesNotMatch(JSON.stringify(report), /claude-test-secret/);
});

test('Antigravity refreshes its existing ACP login and reads grouped short and weekly quotas', async () => {
  const calls = [];
  const report = await readProviderPlanUsage('antigravity', {
    readAntigravityCredentials: async () => ({ refresh_token: 'google-test-refresh', client_id: 'test-client', client_secret: 'test-client-secret', project_id: 'existing-project' }),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url === 'https://oauth2.googleapis.com/token') return json({ access_token: 'google-test-access', expires_in: 3600 });
      if (url.endsWith(':loadCodeAssist')) return json({ currentTier: { name: 'Google AI Pro' }, cloudaicompanionProject: 'existing-project' });
      return json({ groups: [{ displayName: 'Gemini Pro', buckets: [
        { bucketId: 'pro-5h', window: '5h', remainingFraction: 0.75, resetTime: reset },
        { bucketId: 'pro-weekly', window: 'weekly', remainingFraction: 0, resetTime: reset },
      ] }] });
    },
  });
  assert.equal(report.status, 'available');
  assert.equal(report.planType, 'Google AI Pro');
  assert.deepEqual(report.limits[0].windows.map(w => w.remainingPercent), [75, 0]);
  assert.equal(report.limits[0].windows[1].label, 'Weekly limit');
  assert.equal(calls.at(-1).url, 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { project: 'existing-project' });
  assert.ok(calls.every(call => call.options.signal && call.options.redirect === 'error'));
  assert.doesNotMatch(JSON.stringify(report), /google-test|test-client-secret/);
});

test('Copilot asks for account quota without creating a session or prompting a model', async () => {
  const calls = [];
  let closes = 0;
  const report = await readProviderPlanUsage('github-copilot', {
    resolveCopilotRuntime: async () => ({ command: 'fake-copilot' }),
    createCopilotClient: () => ({
      async start() {},
      async request(method, params, timeout) {
        calls.push({ method, params, timeout });
        if (method === 'auth.getStatus') return { isAuthenticated: true };
        return { quotaSnapshots: {
          premium_interactions: { entitlementRequests: 300, usedRequests: 150, remainingPercentage: 50, resetDate: reset },
          chat: { isUnlimitedEntitlement: true, entitlementRequests: -1, usedRequests: 12 },
        } };
      },
      async close() { closes++; },
    }),
  });
  assert.equal(report.status, 'available');
  assert.equal(report.providerID, 'github-copilot');
  assert.equal(report.limits[0].windows[0].label, 'Monthly allowance');
  assert.equal(report.limits[0].windows[0].remainingPercent, 50);
  assert.equal(report.limits[1].windows.length, 0);
  assert.match(report.limits[1].detail, /Unlimited/);
  assert.deepEqual(calls.map(c => c.method), ['auth.getStatus', 'account.getQuota']);
  assert.ok(calls.every(c => c.timeout > 0 && c.timeout <= 15000));
  assert.equal(closes, 1);
});

test('missing provider logins never make network requests or invent a zero allowance', async () => {
  for (const providerID of ['claude-code', 'antigravity']) {
    const report = await readProviderPlanUsage(providerID, {
      readClaudeCredentials: noCredentials, readAntigravityCredentials: noCredentials,
      fetchImpl: async () => { throw new Error('must not request without credentials'); },
    });
    assert.equal(report.status, 'signed-out', providerID);
    assert.deepEqual(report.limits, []);
  }
});

test('HTTP failures and malformed usage stay retryable without exposing provider response bodies', async () => {
  for (const status of [401, 403, 429, 500]) {
    const report = await readProviderPlanUsage('claude-code', {
      readClaudeCredentials: async () => ({ accessToken: 'claude-private-token' }),
      fetchImpl: async () => json({ error: 'private provider body claude-private-token' }, status),
    });
    assert.equal(report.status, status === 401 || status === 403 ? 'signed-out' : 'error');
    assert.deepEqual(report.limits, []);
    assert.doesNotMatch(report.message, /private provider body|claude-private-token/);
  }
  const report = await readProviderPlanUsage('claude-code', {
    readClaudeCredentials: async () => ({ accessToken: 'claude-private-token' }),
    fetchImpl: async () => json({ five_hour: { utilization: null }, seven_day: { utilization: '0' } }),
  });
  assert.equal(report.status, 'unavailable');
  assert.deepEqual(report.limits, []);
});
