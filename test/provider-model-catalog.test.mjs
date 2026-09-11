import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchProviderModelCatalog, parseApiCatalog, discoverAntigravityModels } from '../src/main/provider-model-catalog.mjs';
import { acpModelCatalogFromSession } from '../src/runtime/acp-cli-provider.mjs';

test('OpenAI-compatible catalog preserves provider ids including exact auto ids', async () => {
  const requests = [];
  const catalog = await fetchProviderModelCatalog({ providerID: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'secret', model: 'openrouter/auto' }, {
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, json: async () => ({ data: [
        { id: 'openrouter/auto', name: 'Auto Router', description: 'Provider-owned routing', supported_parameters: ['tools'] },
        { id: 'vendor/model-a', name: 'Model A', supported_parameters: ['tools'] },
      ] }) };
    },
  });
  assert.equal(catalog.source, 'api');
  assert.deepEqual(catalog.models.map((item) => item.id), ['openrouter/auto', 'vendor/model-a']);
  assert.equal(catalog.defaultModel, null);
  assert.match(requests[0].url, /supported_parameters=tools/);
  assert.equal(requests[0].init.headers.authorization, 'Bearer secret');
});

test('Anthropic model list uses provider-advertised labels and explicit defaults only', () => {
  const catalog = parseApiCatalog('anthropic', { data: [
    { id: 'claude-sonnet-x', display_name: 'Claude Sonnet X', max_input_tokens: 200000 },
    { id: 'auto', display_name: 'Auto', is_default: true },
  ] });
  assert.deepEqual(catalog.models.map((item) => item.id), ['claude-sonnet-x', 'auto']);
  assert.equal(catalog.defaultModel, 'auto');
  assert.equal(catalog.models[0].label, 'Claude Sonnet X');
});

test('Gemini catalog keeps only entries the API advertises for generateContent', () => {
  const catalog = parseApiCatalog('google', { models: [
    { name: 'models/gemini-live', displayName: 'Gemini Live', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1000 },
    { name: 'models/text-embedding', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
  ] });
  assert.deepEqual(catalog.models.map((item) => item.id), ['gemini-live']);
});

test('ACP session config model selector preserves exact current Auto value', () => {
  const catalog = acpModelCatalogFromSession({
    configOptions: [{
      id: 'model', category: 'model', type: 'select', currentValue: 'auto',
      options: [{ value: 'auto', name: 'Auto' }, { value: 'provider/model-x', name: 'Model X' }],
    }],
  });
  assert.equal(catalog.configId, 'model');
  assert.equal(catalog.defaultModel, 'auto');
  assert.deepEqual(catalog.models.map((item) => item.id), ['auto', 'provider/model-x']);
});

test('Antigravity model command parser uses advertised slugs without choosing a default', async () => {
  const catalog = await discoverAntigravityModels({ command: 'agy', envOverride: 'CUPPET_ANTIGRAVITY_BIN' }, {
    runImpl: async () => ({ stdout: 'gemini-3.8-flash-high     Gemini 3.8 Flash (High)\nclaude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)\n' }),
  });
  assert.deepEqual(catalog.models.map((item) => item.id), ['gemini-3.8-flash-high', 'claude-sonnet-4-6']);
  assert.equal(catalog.defaultModel, null);
});
