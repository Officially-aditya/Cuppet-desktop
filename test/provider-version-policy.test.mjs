import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderControlPlane } from '../src/runtime/providers/control-plane.mjs';
import {
  localProviderVersionCompatibility,
  localProviderVersionPolicy,
} from '../src/runtime/providers/version-policy.mjs';

test('OpenCode production policy matches the authenticated ACP acceptance floor', () => {
  assert.deepEqual(localProviderVersionPolicy('opencode'), { minimumVersion: '1.18.30' });
  assert.equal(localProviderVersionCompatibility('opencode', 'opencode 1.18.29').state, 'too_old');
  assert.equal(localProviderVersionCompatibility('opencode', 'opencode 1.18.29').supported, false);
  assert.equal(localProviderVersionCompatibility('opencode', '1.18.30').supported, true);
  assert.equal(localProviderVersionCompatibility('opencode', 'OpenCode 1.19.0').supported, true);
  assert.equal(localProviderVersionCompatibility('opencode', 'development build').state, 'unverified');
  assert.equal(localProviderVersionCompatibility('kiro', 'anything').state, 'not_required');
});

test('incompatible external OpenCode is installed but blocked before auth probing', async () => {
  const calls = [];
  const operations = fakeOperations({
    calls,
    detected: installedState('opencode 1.18.29', { ownedByCuppet: false, canUpdate: false }),
  });
  const plane = controlPlane(operations);

  const status = await plane.localStatus('opencode');
  assert.equal(status.installed, true);
  assert.equal(status.connected, false);
  assert.equal(status.control.overall, 'needs_update');
  assert.equal(status.control.installation.compatibility.state, 'too_old');
  assert.equal(status.control.installation.compatibility.minimumVersion, '1.18.30');
  assert.equal(status.control.authentication.state, 'blocked');
  assert.equal(status.control.capabilities.state, 'blocked');
  assert.match(status.message, /requires OpenCode 1\.18\.30 or newer/i);
  assert.deepEqual(calls, ['detect']);
});

test('connect never mutates or authenticates an incompatible external install', async () => {
  const calls = [];
  const operations = fakeOperations({
    calls,
    detected: installedState('opencode 1.18.29', { ownedByCuppet: false, canUpdate: false }),
  });
  const plane = controlPlane(operations);

  await assert.rejects(() => plane.localConnect('opencode'), (error) => {
    assert.equal(error.code, 'PROVIDER_VERSION_UNSUPPORTED');
    assert.match(error.message, /tested minimum 1\.18\.30/i);
    return true;
  });
  assert.deepEqual(calls, ['detect']);
});

test('connect repairs an incompatible Cuppet-managed install before authentication', async () => {
  const calls = [];
  let version = 'opencode 1.18.29';
  const managedInstallation = () => ({
    detected: true,
    executable: '/managed/opencode',
    version,
    source: 'managed',
    ownedByCuppet: true,
    canUpdate: true,
    identity: null,
  });
  const operations = {
    async detect() {
      calls.push('detect');
      return { providerID: 'opencode', label: 'OpenCode', installed: true, version, installation: managedInstallation() };
    },
    async update() {
      calls.push('update');
      version = 'opencode 1.18.30';
      return { providerID: 'opencode', label: 'OpenCode', installed: true, version, installation: managedInstallation() };
    },
    async connect() {
      calls.push('connect');
      return { providerID: 'opencode', label: 'OpenCode', installed: true, connected: true, available: true, version, installation: managedInstallation(), probe: 'provider' };
    },
  };
  const plane = controlPlane(operations);

  const status = await plane.localConnect('opencode');
  assert.equal(status.control.overall, 'ready');
  assert.equal(status.control.installation.compatibility.state, 'compatible');
  assert.equal(status.control.authentication.state, 'authenticated');
  assert.deepEqual(calls, ['detect', 'update', 'connect']);
});

test('unparseable version output fails closed when a minimum is required', async () => {
  const calls = [];
  const operations = fakeOperations({
    calls,
    detected: installedState('OpenCode development build', { ownedByCuppet: false, canUpdate: false }),
  });
  const plane = controlPlane(operations);

  const status = await plane.localProbe('opencode');
  assert.equal(status.control.overall, 'needs_update');
  assert.equal(status.control.installation.compatibility.state, 'unverified');
  assert.equal(status.control.authentication.state, 'blocked');
  assert.deepEqual(calls, ['detect']);
});

function controlPlane(operations) {
  return new ProviderControlPlane({
    dataDir: '/tmp/cuppet-version-policy-test',
    operationsFactory: () => operations,
    runtimeHealth: () => ({ state: 'stopped' }),
    capabilityDiscovery: async () => ({ models: [] }),
  });
}

function fakeOperations({ calls, detected }) {
  return {
    async detect() { calls.push('detect'); return structuredClone(detected); },
    async status() { calls.push('status'); return { ...structuredClone(detected), connected: false, available: false }; },
    async probe() { calls.push('probe'); return { ...structuredClone(detected), connected: false, available: false }; },
    async update() { calls.push('update'); return structuredClone(detected); },
    async connect() { calls.push('connect'); return { ...structuredClone(detected), connected: true, available: true }; },
    async install() { calls.push('install'); return structuredClone(detected); },
  };
}

function installedState(version, { ownedByCuppet, canUpdate }) {
  return {
    providerID: 'opencode',
    label: 'OpenCode',
    installed: true,
    version,
    installation: {
      detected: true,
      executable: '/external/opencode',
      version,
      source: ownedByCuppet ? 'managed' : 'unknown',
      ownedByCuppet,
      canUpdate,
      identity: null,
    },
  };
}
