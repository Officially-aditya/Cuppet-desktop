import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogFromCodexModels, fetchProviderModelCatalog, parseApiCatalog } from '../src/main/provider-model-catalog.mjs';
import { capabilitiesFromAcpSession } from '../src/runtime/providers/transports/acp/acp-capabilities.mjs';
import { catalogFromAcpCapabilities } from '../src/runtime/providers/transports/acp/acp-discovery.mjs';

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
  assert.notEqual(catalog.modelDependentSettings, true);
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

test('Codex catalog preserves provider models while resolving Cuppet default sentinel through advertised default', () => {
  const catalog = catalogFromCodexModels({
    available: true,
    defaultModel: 'codex/model-b',
    models: [
      { id: 'codex/model-a', label: 'Model A', efforts: ['low', 'high'], defaultEffort: 'high' },
      { id: 'codex/model-b', label: 'Model B', isDefault: true, efforts: ['medium', 'xhigh'], defaultEffort: 'xhigh' },
    ],
  }, 'codex-default');
  assert.equal(catalog.source, 'codex');
  assert.equal(catalog.modelDependentSettings, true);
  assert.deepEqual(catalog.models.map((item) => item.id), ['codex/model-a', 'codex/model-b']);
  assert.equal(catalog.models.some((item) => item.id === 'codex-default'), false);
  assert.equal(catalog.defaultModel, 'codex/model-b');
  assert.equal(catalog.configuredModel, 'codex-default');
  assert.equal(catalog.reasoning.currentValue, 'xhigh');
  assert.deepEqual(catalog.reasoning.options.map((item) => item.id), ['medium', 'xhigh']);
});

test('Codex candidate refresh uses the generic catalog and model-dependent effort contract', async () => {
  const catalog = await fetchProviderModelCatalog({ providerID: 'codex', model: 'codex-default' }, {
    model: 'codex/model-a',
    codexDiscover: async () => ({
      available: true,
      defaultModel: 'codex/model-b',
      models: [
        { id: 'codex/model-a', label: 'Model A', efforts: ['low', 'high'], defaultEffort: 'high' },
        { id: 'codex/model-b', label: 'Model B', isDefault: true, efforts: ['medium'], defaultEffort: 'medium' },
      ],
    }),
  });
  assert.equal(catalog.defaultModel, 'codex/model-b');
  assert.equal(catalog.configuredModel, 'codex/model-a');
  assert.equal(catalog.modelDependentSettings, true);
  assert.equal(catalog.reasoning.currentValue, 'high');
  assert.deepEqual(catalog.reasoning.options.map((item) => item.id), ['low', 'high']);
});

test('shared ACP session parser preserves exact current Auto without inventing a default', () => {
  const capabilities = capabilitiesFromAcpSession({
    configOptions: [{
      id: 'model', category: 'model', type: 'select', currentValue: 'auto',
      options: [{ value: 'auto', name: 'Auto' }, { value: 'provider/model-x', name: 'Model X' }],
    }],
  });
  const catalog = catalogFromAcpCapabilities('claude-code', capabilities);
  assert.equal(catalog.configId, 'model');
  assert.equal(catalog.currentModel, 'auto');
  assert.equal(catalog.defaultModel, null);
  assert.deepEqual(catalog.models.map((item) => item.id), ['auto', 'provider/model-x']);
});

test('shared ACP capability conversion preserves exact model and reasoning values', () => {
  const catalog = catalogFromAcpCapabilities('claude-code', {
    models: [{ id: 'auto', label: 'Auto' }, { id: 'provider/model-x', label: 'Model X' }],
    settings: [
      { id: 'model', kind: 'select', category: 'model', label: 'Model', value: 'auto', options: [{ id: 'auto', label: 'Auto' }, { id: 'provider/model-x', label: 'Model X' }] },
      { id: 'effort', kind: 'select', category: 'thought_level', label: 'Effort', value: 'xhigh', options: [{ id: 'minimal', label: 'Minimal' }, { id: 'xhigh', label: 'Extra High' }] },
    ],
  });
  assert.deepEqual(catalog.models.map((item) => item.id), ['auto', 'provider/model-x']);
  assert.equal(catalog.currentModel, 'auto');
  assert.equal(catalog.defaultModel, null);
  assert.equal(catalog.reasoning.currentValue, 'xhigh');
  assert.deepEqual(catalog.reasoning.options.map((item) => item.id), ['minimal', 'xhigh']);
});

test('candidate model refresh is read-only and drops old explicit effort before ACP discovery', async () => {
  let discoveryConfiguration;
  const catalog = await fetchProviderModelCatalog({
    providerID: 'claude-code',
    model: 'provider/model-a',
    primary: { providerID: 'claude-code', modelID: 'provider/model-a', variant: 'high' },
    primaryEffort: 'high',
  }, {
    model: 'provider/model-b',
    acpDiscover: async (_providerID, options) => {
      discoveryConfiguration = options.configuration;
      return {
        models: [{ id: 'provider/model-a', label: 'Model A' }, { id: 'provider/model-b', label: 'Model B' }],
        defaultModel: 'provider/model-a',
        currentModel: 'provider/model-b',
        configOptions: [],
        reasoning: {
          configId: 'effort',
          currentValue: 'medium',
          options: [{ id: 'medium', label: 'Medium' }, { id: 'max', label: 'Max' }],
        },
      };
    },
  });

  assert.equal(discoveryConfiguration.model, 'provider/model-b');
  assert.equal(discoveryConfiguration.primary.modelID, 'provider/model-b');
  assert.equal(discoveryConfiguration.primaryEffort, '');
  assert.equal(Object.prototype.hasOwnProperty.call(discoveryConfiguration.primary, 'variant'), false);
  assert.equal(catalog.configuredModel, 'provider/model-b');
  assert.equal(catalog.defaultModel, 'provider/model-a');
  assert.equal(catalog.modelDependentSettings, true);
  assert.equal(catalog.reasoning.currentValue, 'medium');
});

test('provider model catalog preserves injected ACP reasoning metadata', async () => {
  const catalog = await fetchProviderModelCatalog({ providerID: 'claude-code', model: 'provider/model-x', primary: { providerID: 'claude-code', modelID: 'provider/model-x' } }, {
    acpDiscover: async (_providerID, options) => {
      assert.equal(options.configuration.model, 'provider/model-x');
      return {
        models: [{ id: 'provider/model-x', label: 'Model X' }],
        currentModel: 'provider/model-x',
        configOptions: [],
        reasoning: { configId: 'effort', currentValue: 'high', options: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] },
      };
    },
  });
  assert.equal(catalog.modelDependentSettings, true);
  assert.equal(catalog.reasoning.configId, 'effort');
  assert.deepEqual(catalog.reasoning.options.map((item) => item.id), ['low', 'high']);
});
