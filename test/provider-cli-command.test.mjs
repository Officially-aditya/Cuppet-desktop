import assert from 'node:assert/strict';
import test from 'node:test';
import { probeProviderCommand, runProviderCommand } from '../src/runtime/providers/cli-command.mjs';
import { preflightClaudeInstall } from '../src/runtime/providers/local-provider-operations.mjs';
import { ProviderControlPlane } from '../src/runtime/providers/control-plane.mjs';
import { copilotAcpArguments } from '../src/runtime/copilot-acp-runtime.mjs';

test('cold CLI probes retry once with a longer timeout, not on ordinary failures', async () => {
  const budgets = [];
  const result = await probeProviderCommand('provider', ['--version'], { runImpl: async (_, __, budget) => {
    budgets.push(budget);
    if (budgets.length === 1) throw Object.assign(new Error('cold start timed out'), { code: 'PROVIDER_TIMEOUT' });
    return { stdout: '1.2.3' };
  } });
  assert.deepEqual(budgets, [8_000, 30_000]);
  assert.equal(result.stdout, '1.2.3');
  let attempts = 0;
  await assert.rejects(() => probeProviderCommand('provider', [], { runImpl: async () => {
    attempts += 1; throw new Error('unsupported option');
  } }), /unsupported option/);
  assert.equal(attempts, 1);
});

test('provider children do not inherit Electron’s runtime flag', async () => {
  const result = await runProviderCommand(process.execPath, ['-e', 'process.stdout.write(String(process.env.ELECTRON_RUN_AS_NODE))'], 3_000, {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  assert.equal(result.stdout, 'undefined');
});

test('provider command timeouts are identifiable and cancellation stops a child', async () => {
  await assert.rejects(() => runProviderCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], 50), { code: 'PROVIDER_TIMEOUT' });
  const controller = new AbortController();
  const result = runProviderCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], 30_000, { signal: controller.signal });
  controller.abort();
  await assert.rejects(() => result, /cancelled/);
});

test('Copilot uses the supported sync-off option without depending on a version string', () => {
  const modern = copilotAcpArguments('--acp --sync-session[=on|off]\n--no-remote Removed');
  assert.ok(modern.includes('--sync-session=off'));
  assert.ok(!modern.includes('--no-remote'));
  assert.ok(!modern.includes('--no-remote-export'));
  const legacy = copilotAcpArguments('--acp --no-remote --no-remote-export');
  assert.ok(legacy.includes('--no-remote-export'));
  assert.ok(!legacy.some((arg) => arg.startsWith('--sync-session')));
  assert.throws(() => copilotAcpArguments('--acp'), /disable session syncing/);
});

for (const providerID of ['opencode', 'mistral-vibe']) {
  test(`${providerID} probe timeout requires retry and never triggers an upgrade`, async () => {
    const state = { providerID, label: providerID, installed: true, version: null, error: 'CLI timed out.', installation: { detected: true, ownedByCuppet: true, canUpdate: true } };
    const plane = new ProviderControlPlane({
      dataDir: '/tmp/cuppet-timeout-control', runtimeHealth: () => null,
      operationsFactory: () => ({
        async detect() { return state; },
        async update() { throw new Error('must not update'); },
        async connect() { throw new Error('must not authenticate'); },
      }),
    });
    const status = await plane.localStatus(providerID);
    assert.equal(status.installed, true);
    assert.equal(status.control.overall, 'needs_retry');
    assert.equal(status.control.authentication.state, 'unknown');
    assert.match(status.message, /timed out/);
    await assert.rejects(() => plane.localConnect(providerID), /timed out/);
  });
}

test('Claude installer checks Node, npm, and global directory permissions before installation', async () => {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, args]);
    return { stdout: command === 'node' ? 'v22.21.0' : args[0] === 'root' ? '/user/npm/node_modules' : '10.9.0' };
  };
  await preflightClaudeInstall(run, 'linux', async () => {});
  assert.deepEqual(calls.map(([command]) => command), ['node', 'npm', 'npm']);
  await assert.rejects(() => preflightClaudeInstall(async () => ({ stdout: 'v20.0.0' }), 'linux'), /Node.js 22/);
  await assert.rejects(() => preflightClaudeInstall(async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }, 'linux'), /Install Node.js/);
  await assert.rejects(() => preflightClaudeInstall(run, 'linux', async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }), /user-owned npm prefix/);
});
