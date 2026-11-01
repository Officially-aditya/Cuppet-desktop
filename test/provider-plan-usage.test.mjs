import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { normalizeCodexPlanUsage, readProviderPlanUsage } from '../src/runtime/provider-plan-usage.mjs';

const quota = (usedPercent, windowDurationMins = 10080, resetsAt = 2000000000) => ({ usedPercent, windowDurationMins, resetsAt });
const legacy = (primary, secondary = null) => ({ rateLimits: { primary, secondary } });

test('plan usage preserves both short and weekly account windows, including zero and exhausted allowances', () => {
  const result = normalizeCodexPlanUsage(legacy(quota(0, 300), quota(100)), { planType: 'plus', fetchedAt: 123 });
  assert.equal(result.status, 'available');
  assert.equal(result.planType, 'plus');
  assert.equal(result.fetchedAt, 123);
  assert.deepEqual(result.limits[0].windows, [
    { id: 'primary', label: '5-hour limit', usedPercent: 0, remainingPercent: 100, windowDurationMins: 300, resetsAt: 2000000000000 },
    { id: 'secondary', label: 'Weekly limit', usedPercent: 100, remainingPercent: 0, windowDurationMins: 10080, resetsAt: 2000000000000 },
  ]);
});

test('modern buckets override the duplicate legacy bucket and preserve other metered limits', () => {
  const result = normalizeCodexPlanUsage({
    rateLimits: { limitId: 'codex', primary: quota(99) },
    rateLimitsByLimitId: {
      codex: { limitId: 'codex', primary: quota(12.5), planType: 'pro' },
      review: { limitName: 'Code review', secondary: quota(42, 1440) },
      credits: { credits: { unlimited: true, balance: null } },
    },
    accessToken: 'secret-never-forwarded',
  });
  assert.deepEqual(result.limits.map((limit) => limit.id), ['codex', 'review', 'credits']);
  assert.equal(result.limits[0].windows[0].usedPercent, 12.5);
  assert.equal(result.limits[0].windows[0].remainingPercent, 87.5);
  assert.equal(result.limits[1].label, 'Code review');
  assert.equal(result.limits[1].windows[0].label, 'Daily limit');
  assert.equal(result.limits[2].credits.unlimited, true);
  assert.equal(result.planType, 'pro');
  assert.ok(!JSON.stringify(result).includes('secret-never-forwarded'));
});

test('a missing modern bucket falls back to legacy data and credit-only responses retain a zero balance', () => {
  const result = normalizeCodexPlanUsage({
    rateLimitsByLimitId: { review: { credits: { balance: '0', unlimited: false } } },
    rateLimits: { primary: quota(30) },
  });
  assert.equal(result.limits.length, 2);
  assert.equal(result.limits[0].credits.balance, '0');
  assert.equal(result.limits[1].id, 'codex');
});

test('missing or malformed telemetry never becomes a fictitious zero-usage allowance', () => {
  for (const input of [null, [], {}, { rateLimitsByLimitId: [] }, legacy(null),
    ...[undefined, null, '0', NaN, Infinity, {}, []].map((usedPercent) => legacy({ usedPercent }))]) {
    const result = normalizeCodexPlanUsage(input);
    assert.equal(result.status, 'unavailable', JSON.stringify(input));
    assert.deepEqual(result.limits, []);
  }
});

test('window labels follow reported duration; invalid resets remain unknown and progress is bounded', () => {
  for (const resetsAt of [null, '2000000000', -1, 0, Infinity, NaN, 9e12]) {
    const result = normalizeCodexPlanUsage(legacy(quota(-10, 15, resetsAt), quota(120, null, resetsAt)));
    const [primary, secondary] = result.limits[0].windows;
    assert.equal(primary.label, '15-minute limit');
    assert.equal(primary.usedPercent, 0);
    assert.equal(secondary.label, 'Secondary limit');
    assert.equal(secondary.usedPercent, 100);
    assert.equal(primary.resetsAt, null);
    assert.equal(secondary.resetsAt, null);
  }
});

function clientFixture({ account = { type: 'chatgpt', planType: 'plus' }, failure, failStart = false, closeFails = false } = {}) {
  const calls = [];
  let closes = 0;
  const client = {
    async start() { if (failStart) throw failure; },
    async request(method, params, timeout) {
      calls.push({ method, params, timeout });
      if (method === 'account/read') return { account };
      if (failure) throw failure;
      return legacy(quota(20, 300), quota(70));
    },
    async close() { closes++; if (closeFails) throw new Error('already closed'); },
  };
  return { calls, client, closes: () => closes, options: { resolveCommand: async () => ({ command: 'fake' }), createClient: () => client } };
}

test('only a ChatGPT account can query the subscription limits, and every client is retired', async () => {
  for (const account of [null, { type: 'apiKey' }]) {
    const fixture = clientFixture({ account });
    const result = await readProviderPlanUsage('codex', fixture.options);
    assert.equal(result.status, 'signed-out');
    assert.deepEqual(fixture.calls.map((call) => call.method), ['account/read']);
    assert.equal(fixture.closes(), 1);
    assert.deepEqual(result.limits, []);
  }
  const fixture = clientFixture({ closeFails: true });
  const result = await readProviderPlanUsage('codex', fixture.options);
  assert.equal(result.status, 'available');
  assert.deepEqual(fixture.calls.map((call) => call.method), ['account/read', 'account/rateLimits/read']);
  assert.ok(fixture.calls.every((call) => call.timeout > 0 && call.timeout <= 15000));
  assert.equal(fixture.closes(), 1);
});

test('unsupported platforms and absent Codex installations do not create or authenticate a client', async () => {
  let resolutions = 0;
  const options = { resolveCommand: async () => { resolutions++; return null; }, createClient: () => { throw new Error('must not create a client'); } };
  for (const id of ['openai', 'opencode', 'grok-build', '']) {
    const result = await readProviderPlanUsage(id, options);
    assert.equal(result.status, 'unsupported');
    assert.equal(result.providerID, id);
    assert.deepEqual(result.limits, []);
  }
  assert.equal(resolutions, 0);
  assert.equal((await readProviderPlanUsage('codex', options)).status, 'unavailable');
  assert.equal(resolutions, 1);
});

test('startup and account-limit failures return an explicit sanitized error and close the client', async () => {
  for (const failStart of [false, true]) {
    const fixture = clientFixture({ failure: new Error('Request failed: Authorization: Bearer private-secret-token'), failStart });
    const result = await readProviderPlanUsage('codex', fixture.options);
    assert.equal(result.status, 'error');
    assert.deepEqual(result.limits, []);
    assert.match(result.message, /Request failed/);
    assert.doesNotMatch(result.message, /private-secret-token/);
    assert.equal(fixture.closes(), 1);
  }
});

test('plan reader uses the real JSON-RPC transport against an initialized app-server', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url));
  const result = await readProviderPlanUsage('codex', {
    resolveCommand: async () => ({ command: process.execPath, args: [fixture] }),
  });
  assert.equal(result.status, 'available');
  assert.equal(result.planType, 'plus');
  assert.equal(result.limits[0].windows[1].label, 'Weekly limit');
  assert.equal(result.limits[0].windows[1].remainingPercent, 25);
});
