import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ProviderControlPlane, withControlState } from '../src/runtime/providers/control-plane.mjs';

test('control plane projects local provider readiness without flattening installation/auth state', () => {
  const missing = withControlState({ providerID: 'opencode', installed: false, connected: false, available: false, installation: { detected: false } });
  assert.equal(missing.control.overall, 'needs_install');
  assert.equal(missing.control.installation.state, 'missing');
  assert.equal(missing.control.authentication.state, 'unknown');
  assert.equal(missing.control.runtime.state, 'stopped');

  const needsAuth = withControlState({ providerID: 'opencode', installed: true, connected: false, available: false, installation: { detected: true, executable: '/tmp/opencode' } });
  assert.equal(needsAuth.control.overall, 'needs_auth');
  assert.equal(needsAuth.control.installation.state, 'external');
  assert.equal(needsAuth.control.authentication.state, 'required');

  const ready = withControlState({ providerID: 'opencode', installed: true, connected: true, available: true, version: '1.2.3', installation: { detected: true, executable: '/tmp/opencode', ownedByCuppet: true, identity: { resolvedPath: '/tmp/opencode', realPath: '/tmp/opencode' } } });
  assert.equal(ready.control.overall, 'ready');
  assert.equal(ready.control.installation.state, 'cuppet_managed');
  assert.equal(ready.control.authentication.state, 'authenticated');
  assert.equal(ready.control.runtime.state, 'stopped', 'authenticated providers may be ready even when their lazy runtime is not warm');
  assert.equal(ready.control.installation.identity.realPath, '/tmp/opencode');
});

test('runtime control plane owns lifecycle operations and composes actual process health', async () => {
  const calls = [];
  const healthCalls = [];
  const plane = new ProviderControlPlane({
    dataDir: '/tmp/cuppet-control-plane-test',
    operationsFactory(providerID, options) {
      calls.push({ providerID, options });
      return {
        async status() { return { providerID, installed: true, connected: true, available: true, installation: { detected: true, executable: '/tmp/opencode' } }; },
        async connect() { return { providerID, installed: true, connected: true, available: true, installation: { detected: true, executable: '/tmp/opencode' } }; },
      };
    },
    runtimeHealth(providerID) {
      healthCalls.push(providerID);
      return { state: 'busy', activeProcesses: 1, busyProcesses: 1, readyProcesses: 0, generation: 2, restarts: 1, lastFailure: null };
    },
    capabilityDiscovery: async () => ({ providerID: 'opencode', source: 'acp', available: true, models: [{ id: 'm1', label: 'M1' }], defaultModel: 'm1', fetchedAt: 1 }),
  });

  const status = await plane.localStatus('opencode');
  assert.equal(status.control.overall, 'ready');
  assert.equal(status.control.runtime.state, 'busy');
  assert.equal(status.control.runtime.activeProcesses, 1);
  assert.equal(status.control.runtime.restarts, 1);
  assert.deepEqual(healthCalls, ['opencode']);
  assert.equal(calls[0].providerID, 'opencode');

  const catalog = await plane.models({ providerID: 'opencode', primary: { providerID: 'opencode', modelID: 'm1' } });
  assert.equal(catalog.providerID, 'opencode');
  assert.equal(catalog.models[0].id, 'm1');
  assert.equal(catalog.configuredModel, 'm1');
});

test('Electron main is a provider-control proxy, not a second lifecycle authority', async () => {
  const main = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8');
  const runtime = await readFile(new URL('../src/runtime/main.mjs', import.meta.url), 'utf8');
  const controlPlane = await readFile(new URL('../src/runtime/providers/control-plane.mjs', import.meta.url), 'utf8');

  assert.doesNotMatch(main, /from '\.\/cli-agent-status\.mjs'/);
  assert.doesNotMatch(main, /from '\.\/provider-model-catalog\.mjs'/);
  assert.match(main, /request\('provider\.local\.status'/);
  assert.match(main, /request\('provider\.local\.connect'/);
  assert.match(main, /request\('provider\.models'/);
  assert.match(main, /CUPPET_USER_DATA_DIR: userData/);

  assert.match(runtime, /new ProviderControlPlane\(\{ dataDir \}\)/);
  assert.match(runtime, /case 'provider\.local\.status'/);
  assert.match(runtime, /case 'provider\.models'/);
  assert.doesNotMatch(controlPlane, /\.\.\/\.\.\/main\//);
  assert.match(controlPlane, /from '\.\/local-provider-operations\.mjs'/);
  assert.match(controlPlane, /from '\.\/runtime-health-registry\.mjs'/);
});
