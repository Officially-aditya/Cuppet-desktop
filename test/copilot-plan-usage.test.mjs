import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CopilotPlanUsageClient } from '../src/runtime/copilot-plan-usage.mjs';
import { readProviderPlanUsage } from '../src/runtime/provider-plan-usage.mjs';
const fixture = fileURLToPath(new URL('./fixtures/fake-copilot-usage-server.mjs', import.meta.url));
const clientFor = scenario => new CopilotPlanUsageClient({ command: process.execPath, args: [fixture, scenario], env: process.env });

test('Copilot plan reader uses a real framed SDK server without opening a session', async () => {
  for (const scenario of ['normal', 'legacy']) {
    const report = await readProviderPlanUsage('github-copilot', {
      resolveCopilotRuntime: async () => ({ command: 'test-server' }),
      createCopilotClient: () => clientFor(scenario),
    });
    assert.equal(report.status, 'available', report.message);
    assert.equal(report.limits[0].windows[0].remainingPercent, 75);
    assert.equal(report.limits[1].label, 'crédits');
  }
});

test('Copilot SDK rejects incompatible protocols and transport startup failures', async () => {
  const incompatible = clientFor('incompatible');
  try { await assert.rejects(incompatible.start(), /Update GitHub Copilot/); }
  finally { await incompatible.close(); }
  const missing = new CopilotPlanUsageClient({ command: '/missing/cuppet-test-copilot', args: [], env: process.env });
  try { await assert.rejects(missing.start(), /could not start|connection closed/); }
  finally { await missing.close(); }
});

test('Copilot SDK failures, exits and timeouts return promptly and can be fully closed', async () => {
  for (const scenario of ['error', 'exit', 'hang']) {
    const client = clientFor(scenario);
    try {
      await client.start();
      await assert.rejects(client.request('account.getQuota', {}, 100), error => {
        assert.doesNotMatch(error.message, /private-token/);
        if (scenario === 'hang') assert.match(error.message, /timed out/);
        return true;
      });
    } finally { await client.close(); await client.close(); }
  }
});
