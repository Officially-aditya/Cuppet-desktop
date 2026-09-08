import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeProviderConfiguration,
  providerProjection,
  providerRequest,
  resolveAdvertisedSelection,
  serializableProviderConfiguration,
} from '../src/runtime/provider-policy.mjs';

function model(modelID, variants = []) {
  return {
    providerID: 'future-provider', modelID, name: modelID, context: 200_000, outputLimit: 32_000,
    capabilities: { tools: true, streaming: true, input: ['text'], output: ['text'] },
    api: { id: `transport-${modelID}` }, request: { headers: { 'x-base': 'yes', authorization: 'must-drop' }, body: { reasoning: { mode: 'pro' } } }, variants,
  };
}

const configuration = () => ({
  providerID: 'future-provider', baseUrl: 'https://provider.example/v1', apiKey: 'host-secret',
  models: [
    model('foreground', [{ id: 'high', headers: { 'x-effort': 'high', authorization: 'drop-me' }, body: { reasoning: { effort: 'high' }, apiKey: 'drop-me' } }]),
    model('worker', [{ id: 'low', body: { reasoning: { effort: 'low' } } }]),
  ],
  primary: { providerID: 'future-provider', modelID: 'foreground', variant: 'high' },
  secondary: { providerID: 'future-provider', modelID: 'worker', variant: 'low' },
});

test('primary and secondary roles resolve independently and effort lowers into request metadata', () => {
  const normalized = normalizeProviderConfiguration(configuration());
  assert.deepEqual(normalized.primary, { providerID: 'future-provider', modelID: 'foreground', variant: 'high' });
  assert.deepEqual(normalized.secondary, { providerID: 'future-provider', modelID: 'worker', variant: 'low' });

  const primary = providerRequest(normalized, 'primary');
  assert.equal(primary.model, 'transport-foreground');
  assert.equal(primary.variant, 'high');
  assert.deepEqual(primary.requestBody.reasoning, { mode: 'pro', effort: 'high' });
  assert.equal(primary.requestHeaders['x-base'], 'yes');
  assert.equal(primary.requestHeaders['x-effort'], 'high');
  assert.equal(primary.requestHeaders.authorization, undefined);
  assert.equal(JSON.stringify(primary.requestBody).includes('drop-me'), false);

  const secondary = providerRequest(normalized, 'secondary');
  assert.equal(secondary.model, 'transport-worker');
  assert.equal(secondary.variant, 'low');
  assert.deepEqual(secondary.requestBody.reasoning, { mode: 'pro', effort: 'low' });
});

test('provider projection is reusable metadata and excludes local credential and endpoint by default', () => {
  const projection = providerProjection(configuration());
  assert.equal(projection.configured, true);
  assert.equal(projection.models.length, 2);
  assert.deepEqual(projection.primaryEfforts, ['high']);
  assert.deepEqual(projection.secondaryEfforts, ['low']);
  const text = JSON.stringify(projection);
  assert.doesNotMatch(text, /host-secret|provider\.example|apiKey|baseUrl|authorization|drop-me/);

  const persisted = serializableProviderConfiguration(configuration());
  assert.equal('apiKey' in persisted, false);
  assert.equal(persisted.baseUrl, 'https://provider.example/v1');
});

test('selection accepts only advertised model and variant and never invents effort', () => {
  const config = normalizeProviderConfiguration(configuration());
  assert.deepEqual(resolveAdvertisedSelection(config, { providerID: 'future-provider', modelID: 'foreground', variant: 'HIGH' }), {
    providerID: 'future-provider', modelID: 'foreground', variant: 'high',
  });
  assert.throws(() => resolveAdvertisedSelection(config, { providerID: 'future-provider', modelID: 'foreground', variant: 'extreme' }), /Available: high/);
  assert.throws(() => resolveAdvertisedSelection(config, { providerID: 'future-provider', modelID: 'unknown' }), /not configured on this host/);
});
