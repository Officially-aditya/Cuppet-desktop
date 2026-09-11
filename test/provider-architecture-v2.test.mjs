import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderBackendRegistry } from '../src/runtime/providers/backend-registry.mjs';
import { normalizeProviderCapabilities, reasoningRuntimeSetting, settingAdvertisesValue } from '../src/runtime/providers/capabilities.mjs';
import { normalizeProviderConnection, patchProviderConnection } from '../src/runtime/providers/connection.mjs';
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
