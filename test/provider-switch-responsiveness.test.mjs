import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { localCliDescriptor, localCliProviderIDs } from '../src/runtime/local-cli-descriptors.mjs';
import { localProviderOperations } from '../src/runtime/providers/local-provider-operations.mjs';
import { discoverAcpRuntimeCatalog } from '../src/runtime/providers/transports/acp/acp-discovery.mjs';
import { fileURLToPath } from 'node:url';
import { ProviderControlPlane } from '../src/runtime/providers/control-plane.mjs';
import { ProviderRuntimeManager } from '../src/runtime/providers/runtime-manager.mjs';
import { ManagedAntigravityProvider, antigravityAcpDescriptor } from '../src/runtime/providers/backends/antigravity.mjs';
import { AcpProviderAdapter } from '../src/runtime/providers/backends/acp.mjs';
import { AcpSessionRuntime } from '../src/runtime/providers/transports/acp/acp-session.mjs';
import { runtimeRequestTimeoutMs } from '../src/main/runtime-client.mjs';
import { SupervisedAcpSessionRuntime } from '../src/runtime/providers/transports/acp/supervised-acp-runtime.mjs';
import { providerRuntimeHealth, resetProviderRuntimeHealthForTests } from '../src/runtime/providers/runtime-health-registry.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-acp-config-agent.mjs', import.meta.url));
const installation = { command: process.execPath, args: [fixture], harnessPath: fixture };
const ready = (providerID) => ({ providerID, installed: true, connected: true, available: true, version: 'opencode 1.18.30' });

test('provider switches share pending status checks and reuse fresh state while runtime health stays live', async () => {
  let now = 1, checks = 0, health = 'ready';
  let complete;
  const plane = new ProviderControlPlane({
    dataDir: tmpdir(), now: () => now,
    operationsFactory: () => ({
      status: () => { checks++; return new Promise((resolve) => { complete = resolve; }); },
    }),
    runtimeHealth: () => ({ state: health }),
  });
  const a = plane.localStatus('antigravity');
  const b = plane.localStatus('antigravity');
  assert.equal(checks, 1);
  complete(ready('antigravity'));
  assert.deepEqual(await a, await b);
  health = 'crashed';
  const cached = await plane.localStatus('antigravity');
  assert.equal(cached.control.runtime.state, 'crashed');
  assert.equal(checks, 1);
  now += 30_000;
  const expired = plane.localStatus('antigravity');
  assert.equal(checks, 2);
  complete(ready('antigravity'));
  await expired;
});

test('OpenCode status passes detection to its auth probe without detecting twice', async () => {
  let detections = 0;
  const detected = ready('opencode');
  const plane = new ProviderControlPlane({
    dataDir: tmpdir(),
    operationsFactory: () => ({
      detect: async () => { detections++; return detected; },
      status: async (input) => { assert.equal(input.providerID, 'opencode'); return input; },
    }),
  });
  await plane.localStatus('opencode');
  await plane.localStatus('opencode');
  assert.equal(detections, 1);
});

test('connect replaces cached status and a late old status check cannot overwrite it', async () => {
  let complete, checks = 0;
  const plane = new ProviderControlPlane({
    dataDir: tmpdir(),
    operationsFactory: () => ({
      detect: async () => ready('antigravity'),
      connect: async () => ready('antigravity'),
      status: () => { checks++; return new Promise((resolve) => { complete = resolve; }); },
    }),
  });
  const before = plane.localStatus('antigravity');
  await plane.localConnect('antigravity');
  complete({ ...ready('antigravity'), connected: false, available: false });
  await before;
  assert.equal((await plane.localStatus('antigravity')).connected, true);
  assert.equal(checks, 1);
});

test('Antigravity participates in warm process reuse across OpenCode switches', async (t) => {
  let resolutions = 0, processes = 0;
  const manager = new ProviderRuntimeManager({
    usageRecorder: async () => {},
    acpRuntimeFactory: (options) => { processes++; return new AcpSessionRuntime(options); },
  });
  t.after(() => manager.close());
  const antigravity = () => new ManagedAntigravityProvider({
    providerID: 'antigravity', primary: { modelID: 'provider/model-b', variant: 'max' },
  }, { resolveInstallation: async (_configuration, options) => {
    assert.equal(options.allowInstall, false);
    resolutions++;
    return installation;
  } });
  const run = (adapter) => manager.adapterFor({ sessionId: 'switch-chat', projectRoot: tmpdir(), adapter })
    .stream([{ role: 'user', content: 'hello' }]);
  assert.equal((await run(antigravity())).text, 'Done.');
  await run(new AcpProviderAdapter({ providerID: 'opencode', primary: { modelID: 'provider/model-b', variant: 'max' }, cliCommand: process.execPath, cliArgs: [fixture] }));
  assert.equal((await run(antigravity())).text, 'Done.');
  assert.equal(resolutions, 1);
  assert.equal(processes, 2);
  assert.equal(manager.size, 2);
});

for (const output of ['stdout', 'stderr']) {
  test('Antigravity missing sign-in fails promptly on ' + output + ' instead of timing out', async (t) => {
    const path = fileURLToPath(new URL('./fixtures/fake-antigravity-auth-acp.mjs', import.meta.url));
    const runtime = new AcpSessionRuntime({
      descriptor: antigravityAcpDescriptor({ command: process.execPath, harnessPath: path, args: [path] }),
      configuration: { cliEnv: { FAKE_AUTH_OUTPUT: output } },
      liveness: { startupMs: 1_000, authenticationMs: 1_000 },
    });
    t.after(() => runtime.close());
    await assert.rejects(runtime.start(), (error) => {
      assert.equal(error.code, 'PROVIDER_AUTHENTICATION_REQUIRED');
      assert.match(error.message, /Sign in.*Settings/);
      assert.doesNotMatch(error.message, /accounts\.google/);
      return true;
    });
  });
}

test('explicit Antigravity Connect permits the browser sign-in prompt to complete', async (t) => {
  const path = fileURLToPath(new URL('./fixtures/fake-antigravity-auth-acp.mjs', import.meta.url));
  const runtime = new AcpSessionRuntime({
    descriptor: antigravityAcpDescriptor({ command: process.execPath, harnessPath: path, args: [path] }),
    configuration: { allowInteractiveAuth: true, cliEnv: { FAKE_AUTH_COMPLETE: '1' } },
    liveness: { startupMs: 1_000, authenticationMs: 1_000 },
  });
  t.after(() => runtime.close());
  assert.equal((await runtime.start()).state, 'ready');
});

test('a native sign-in failure enables reconnect even when an old linked status was cached', async (t) => {
  resetProviderRuntimeHealthForTests();
  t.after(resetProviderRuntimeHealthForTests);
  const path = fileURLToPath(new URL('./fixtures/fake-antigravity-auth-acp.mjs', import.meta.url));
  const runtime = new SupervisedAcpSessionRuntime({
    descriptor: antigravityAcpDescriptor({ command: process.execPath, harnessPath: path, args: [path] }),
    liveness: { startupMs: 1_000, authenticationMs: 1_000 },
  });
  t.after(() => runtime.close());
  const plane = new ProviderControlPlane({
    dataDir: tmpdir(),
    operationsFactory: () => ({ status: async () => ready('antigravity') }),
  });
  assert.equal((await plane.localStatus('antigravity')).connected, true);
  await assert.rejects(runtime.start(), { code: 'PROVIDER_AUTHENTICATION_REQUIRED' });
  await runtime.close();
  assert.equal(providerRuntimeHealth('antigravity').lastFailure.category, 'authentication');
  const status = await plane.localStatus('antigravity');
  assert.equal(status.connected, false);
  assert.equal(status.control.overall, 'needs_auth');
});

test('desktop provider requests allow installation and ACP startup to finish beyond the ordinary request budget', () => {
  assert.ok(runtimeRequestTimeoutMs('provider.local.connect') >= 5 * 60_000);
  assert.ok(runtimeRequestTimeoutMs('provider.models') >= 2 * 120_000);
  assert.equal(runtimeRequestTimeoutMs('session.get'), 30_000);
});

test('model and effort discovery uses one ACP process and keeps the provider default', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cuppet-discovery-startup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = join(directory, 'initializations');
  const catalog = await discoverAcpRuntimeCatalog('claude-code', {
    configuration: {
      cliCommand: process.execPath, cliArgs: [fixture], cliEnv: { FAKE_ACP_INITIALIZE_LOG: log },
      primary: { modelID: 'provider/model-b', variant: 'max' }, primaryEffort: 'max',
    },
  });
  assert.equal(catalog.defaultModel, 'provider/model-a');
  assert.equal(catalog.currentModel, 'provider/model-b');
  assert.equal(catalog.reasoning.currentValue, 'medium');
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 1);
});

test('every local ACP provider stays warm when switching away and back', async (t) => {
  const ids = localCliProviderIDs().filter((id) => localCliDescriptor(id).transport === 'acp');
  let processes = 0;
  const manager = new ProviderRuntimeManager({
    maxWarmRuntimes: ids.length, usageRecorder: async () => {},
    acpRuntimeFactory: (options) => { processes++; return new AcpSessionRuntime(options); },
  });
  t.after(() => manager.close());
  for (let pass = 0; pass < 2; pass++) {
    for (const providerID of ids) {
      const adapter = new AcpProviderAdapter({
        providerID, cliCommand: process.execPath, cliArgs: [fixture],
        primary: { modelID: 'provider/model-b', variant: 'max' },
      });
      const result = await manager.adapterFor({ sessionId: 'all-providers-switch', adapter })
        .stream([{ role: 'user', content: 'hello' }]);
      assert.equal(result.text, 'Done.', providerID);
    }
  }
  assert.equal(processes, ids.length);
});

for (const providerID of localCliProviderIDs().filter((id) => localCliDescriptor(id).transport === 'acp')) {
  test(providerID + ' reports expired authentication without transport restart retries', async (t) => {
    resetProviderRuntimeHealthForTests();
    t.after(resetProviderRuntimeHealthForTests);
    const runtime = new SupervisedAcpSessionRuntime({
      descriptor: localCliDescriptor(providerID),
      configuration: { cliCommand: process.execPath, cliArgs: [fixture], cliEnv: { FAKE_ACP_AUTH_REQUIRED: '1' } },
    }, { versionPreflight: async () => {} });
    t.after(() => runtime.close());
    await assert.rejects(runtime.start(), { code: 'PROVIDER_AUTHENTICATION_REQUIRED' });
    assert.equal(providerRuntimeHealth(providerID).lastFailure.category, 'authentication');
    assert.equal(runtime.snapshot().supervisor.restarts, 0);
  });
}

test('Copilot reconnect actually runs login after ACP rejects an old linked marker', async (t) => {
  resetProviderRuntimeHealthForTests();
  t.after(resetProviderRuntimeHealthForTests);
  const userData = await mkdtemp(join(tmpdir(), 'cuppet-copilot-reconnect-'));
  t.after(() => rm(userData, { recursive: true, force: true }));
  await writeFile(join(userData, 'cli-agent-links.json'), JSON.stringify({
    providers: { 'github-copilot': { linkedAt: 1 } },
  }));
  const runtime = new SupervisedAcpSessionRuntime({
    descriptor: localCliDescriptor('github-copilot'),
    configuration: { cliCommand: process.execPath, cliArgs: [fixture], cliEnv: { FAKE_ACP_AUTH_REQUIRED: '1' } },
  });
  t.after(() => runtime.close());
  await assert.rejects(runtime.start(), { code: 'PROVIDER_AUTHENTICATION_REQUIRED' });
  await runtime.close();
  let logins = 0;
  const plane = new ProviderControlPlane({
    dataDir: userData,
    operationsFactory: () => localProviderOperations('github-copilot', {
      userData, resolveCopilotRuntimeImpl: async () => ({ command: process.execPath, source: 'native' }),
      runImpl: async (_command, args) => {
        if (args.includes('--version')) return { stdout: 'Copilot 1.0.95' };
        if (args[0] === 'login') { logins++; return { stdout: '' }; }
        throw new Error('No active credentials');
      },
    }),
  });
  assert.equal((await plane.localStatus('github-copilot')).control.overall, 'needs_auth');
  assert.equal((await plane.localConnect('github-copilot')).connected, true);
  assert.equal(logins, 1);
  assert.equal(providerRuntimeHealth('github-copilot').lastFailure, null);
});

test('authentication failure during model discovery makes an old linked provider reconnectable', async (t) => {
  resetProviderRuntimeHealthForTests();
  t.after(resetProviderRuntimeHealthForTests);
  const plane = new ProviderControlPlane({
    dataDir: tmpdir(), operationsFactory: () => ({ status: async () => ready('github-copilot') }),
  });
  assert.equal((await plane.localStatus('github-copilot')).connected, true);
  await assert.rejects(discoverAcpRuntimeCatalog('github-copilot', {
    configuration: { cliCommand: process.execPath, cliArgs: [fixture], cliEnv: { FAKE_ACP_AUTH_REQUIRED: '1' } },
  }), { code: 'PROVIDER_AUTHENTICATION_REQUIRED' });
  assert.equal((await plane.localStatus('github-copilot')).control.overall, 'needs_auth');
});

