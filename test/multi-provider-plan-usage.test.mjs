import test from 'node:test';
import assert from 'node:assert/strict';
import { readProviderPlanUsage } from '../src/runtime/provider-plan-usage.mjs';

const reset = '2030-01-02T03:04:05Z';

test('Claude and Antigravity plan usage stays inside the provider apps', async () => {
  let credentialReads = 0;
  let requests = 0;
  for (const providerID of ['claude-code', 'antigravity']) {
    const report = await readProviderPlanUsage(providerID, {
      readClaudeCredentials: async () => { credentialReads++; return { accessToken: 'unused' }; },
      readAntigravityCredentials: async () => { credentialReads++; return { token: 'unused' }; },
      fetchImpl: async () => { requests++; throw new Error('Cuppet must not call provider usage endpoints'); },
    });
    assert.equal(report.status, 'unsupported');
    assert.deepEqual(report.limits, []);
    assert.match(report.message, /Check usage in/);
  }
  assert.equal(credentialReads, 0);
  assert.equal(requests, 0);
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
