import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderBackendRegistry } from '../src/runtime/providers/backend-registry.mjs';
import { normalizeProviderCapabilities, reasoningRuntimeSetting, settingAdvertisesValue } from '../src/runtime/providers/capabilities.mjs';
import { normalizeProviderConnection, patchProviderConnection } from '../src/runtime/providers/connection.mjs';
import { normalizeProviderInstallation, providerOperationKind } from '../src/runtime/providers/operations.mjs';
import { legacyProviderRuntime } from '../src/runtime/providers/runtime-contract.mjs';

test('capabilities preserve provider-advertised ids without inventing a default', () => {
  const capabilities = normalizeProviderCapabilities({
    models: [
      { id: 'provider/auto', label: 'Auto' },
      { id: 'model-z', label: 'Model Z' },
    ],
    settings: [{
      id: 'effort',
      category: 'thought_level',
      kind: 'select',
      label: 'Effort',
      value: 'xhigh',
      options: [{ id: 'minimal' }, { id: 'xhigh' }],
    }],
  });

  assert.deepEqual(capabilities.models.map((model) => model.id), ['provider/auto', 'model-z']);
  assert.equal(capabilities.models.some((model) => model.isDefault), false);
  const reasoning = reasoningRuntimeSetting(capabilities);
  assert.equal(reasoning?.value, 'xhigh');
  assert.equal(settingAdvertisesValue(reasoning, 'minimal'), true);
  assert.equal(settingAdvertisesValue(reasoning, 'high'), false);
});

test('connection patches do not mutate unrelated preference authority', () => {
  const connection = normalizeProviderConnection({
    id: 'primary-opencode',
    backendId: 'OpenCode',
    auth: { token: 'old-token' },
    preferences: { model: 'model-b', effort: 'max' },
    createdAt: 10,
    updatedAt: 10,
  });

  const updated = patchProviderConnection(connection, { auth: { token: 'new-token' } }, 20);
  assert.equal(updated.backendId, 'opencode');
  assert.deepEqual(updated.preferences, { model: 'model-b', effort: 'max' });
  assert.equal(updated.auth.token, 'new-token');
  assert.equal(updated.createdAt, 10);
  assert.equal(updated.updatedAt, 20);
});

test('backend registry owns runtime construction without leaking backend selection to callers', () => {
  const registry = new ProviderBackendRegistry();
  registry.register({
    id: 'opencode',
    label: 'OpenCode',
    transport: 'acp',
    createRuntime: ({ connection }) => ({ connectionId: connection.id }),
  });
  const connection = normalizeProviderConnection({ id: 'one', backendId: 'opencode' });
  assert.equal(registry.createRuntime(connection).connectionId, 'one');
  assert.throws(() => registry.register({ id: 'opencode', createRuntime() {} }), /already registered/);
});

test('backend registry exposes lifecycle operations without inventing unsupported mutations', async () => {
  const calls = [];
  const registry = new ProviderBackendRegistry();
  registry.register({
    id: 'opencode',
    transport: 'acp',
    operations: {
      detect: async ({ marker }) => { calls.push(['detect', marker]); return { installed: true }; },
      probe: async () => { calls.push(['probe']); return { connected: true }; },
    },
    createRuntime: () => ({ kind: 'runtime' }),
  });

  assert.equal(registry.operationSupport('opencode').detect, true);
  assert.equal(registry.operationSupport('opencode').probe, true);
  assert.equal(registry.operationSupport('opencode').install, false);
  assert.equal(registry.operationSupport('opencode').createRuntime, true);
  assert.deepEqual(await registry.operation('opencode', 'detect', { marker: 7 }), { installed: true });
  assert.deepEqual(calls, [['detect', 7]]);
  await assert.rejects(() => registry.operation('opencode', 'install'), /not supported/);
});

test('provider lifecycle classifies observational and mutating operations explicitly', () => {
  assert.equal(providerOperationKind('detect'), 'read-only');
  assert.equal(providerOperationKind('probe'), 'read-only');
  assert.equal(providerOperationKind('discoverCapabilities'), 'read-only');
  assert.equal(providerOperationKind('install'), 'mutation');
  assert.equal(providerOperationKind('authenticate'), 'mutation');
  assert.equal(providerOperationKind('update'), 'mutation');
  assert.equal(providerOperationKind('createRuntime'), 'runtime');
});

test('installation ownership never grants update authority to unknown external installs', () => {
  const external = normalizeProviderInstallation({ detected: true, executable: '/usr/local/bin/tool', version: '1.2.3', source: 'unknown', canUpdate: true });
  assert.equal(external.detected, true);
  assert.equal(external.source, 'unknown');
  assert.equal(external.canUpdate, false);

  const managed = normalizeProviderInstallation({ detected: true, executable: '/tmp/tool', version: '2.0', source: 'managed', ownedByCuppet: true, canUpdate: true });
  assert.equal(managed.source, 'managed');
  assert.equal(managed.ownedByCuppet, true);
  assert.equal(managed.canUpdate, true);
});

test('legacy runtime converts existing provider callbacks into Cuppet activities', async () => {
  const seen = [];
  const provider = {
    async stream(_messages, hooks) {
      await hooks.onProviderEvent({ type: 'reasoning', text: 'Inspecting files' });
      await hooks.onProviderEvent({ type: 'tool.started', callId: 'call-1', tool: 'read', label: 'Read file' });
      await hooks.onDelta('Done');
      await hooks.onProviderEvent({ type: 'tool.finished', callId: 'call-1', tool: 'read', success: true });
      return { text: 'Done', usage: null };
    },
  };

  const runtime = legacyProviderRuntime(provider);
  const result = await runtime.runTurn({ messages: [{ role: 'user', content: 'hello' }] }, {
    onActivity: async (activity) => seen.push(activity),
  });

  assert.equal(result.text, 'Done');
  assert.deepEqual(seen.map((activity) => activity.type), [
    'activity.reasoning.delta',
    'activity.tool.opened',
    'activity.text.delta',
    'activity.tool.closed',
  ]);
});
