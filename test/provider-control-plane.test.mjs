import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderControlPlane, withControlState } from '../src/runtime/providers/control-plane.mjs';

test('control plane projects local provider readiness without flattening installation/auth state', () => {
  const missing = withControlState({ providerID: 'opencode', installed: false, connected: false, available: false, installation: { detected: false } });
  assert.equal(missing.control.overall, 'needs_install');
  assert.equal(missing.control.installation.state, 'missing');
  assert.equal(missing.control.authentication.state, 'unknown');

  const needsAuth = withControlState({ providerID: 'opencode', installed: true, connected: false, available: false, installation: { detected: true, executable: '/tmp/opencode' } });
  assert.equal(needsAuth.control.overall, 'needs_auth');
  assert.equal(needsAuth.control.installation.state, 'external');
  assert.equal(needsAuth.control.authentication.state, 'required');

  const ready = withControlState({ providerID: 'opencode', installed: true, connected: true, available: true, version: '1.2.3', installation: { detected: true, executable: '/tmp/opencode', ownedByCuppet: true } });
  assert.equal(ready.control.overall, 'ready');
  assert.equal(ready.control.installation.state, 'cuppet_managed');
  assert.equal(ready.control.authentication.state, 'authenticated');
});

test('runtime control plane owns lifecycle operations', async () => {
  const calls = [];
  const plane = new ProviderControlPlane({
    dataDir: '/tmp/cuppet-control-plane-test',
    operationsFactory(providerID, options) {
      calls.push({ providerID, options });
      return {
        async status() { return { providerID, installed: true, connected: true, available: true, installation: { detected: true, executable: '/tmp/opencode' } }; },
        async connect() { return { providerID, installed: true, connected: true, available: true, installation: { detected: true, executable: '/tmp/opencode' } }; },
      };
    },
    capabilityDiscovery: async () => ({ providerID: 'opencode', source: 'acp', available: true, models: [{ id: 'm1', label: 'M1' }], defaultModel: 'm1', fetchedAt: 1 }),
  });

  const status = await plane.localStatus('opencode');
  assert.equal(status.control.overall, 'ready');
  assert.equal(calls[0].providerID, 'opencode');

  const catalog = await plane.models({ providerID: 'opencode', primary: { providerID: 'opencode', modelID: 'm1' } });
  assert.equal(catalog.providerID, 'opencode');
  assert.equal(catalog.models[0].id, 'm1');
  assert.equal(catalog.configuredModel, 'm1');
});
