import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { catalogFromCodexModels, fetchProviderModelCatalog, parseApiCatalog, discoverAntigravityModels } from '../src/main/provider-model-catalog.mjs';
import { capabilitiesFromAcpSession } from '../src/runtime/providers/transports/acp/acp-capabilities.mjs';
import { catalogFromAcpCapabilities, discoverAcpRuntimeCatalog } from '../src/runtime/providers/transports/acp/acp-discovery.mjs';

const acpConfigFixture = fileURLToPath(new URL('./fixtures/fake-acp-config-agent.mjs', import.meta.url));

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

test('Codex candidate refresh uses the same generic catalog and model-dependent effort contract', async () => {
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
  const catalog = catalogFromAcpCapabilities('opencode', capabilities);
  assert.equal(catalog.configId, 'model');
  assert.equal(catalog.currentModel, 'auto');
  assert.equal(catalog.defaultModel, null);
  assert.deepEqual(catalog.models.map((item) => item.id), ['auto', 'provider/model-x']);
});

test('shared ACP capability conversion preserves exact provider model and reasoning values without inferring a default', () => {
  const catalog = catalogFromAcpCapabilities('opencode', {
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

test('main ACP model catalog separates clean provider default from configured model and effort override', async () => {
  const catalog = await fetchProviderModelCatalog({
    providerID: 'opencode',
    cliCommand: process.execPath,
    cliArgs: [acpConfigFixture],
    primary: { modelID: 'provider/model-b' },
    primaryEffort: 'max',
  });
  assert.equal(catalog.source, 'acp');
  assert.equal(catalog.modelDependentSettings, true);
  assert.deepEqual(catalog.models.map((item) => item.id), ['provider/model-a', 'provider/model-b']);
  assert.equal(catalog.defaultModel, 'provider/model-a');
  assert.equal(catalog.configuredModel, 'provider/model-b');
  assert.equal(catalog.reasoning.currentValue, 'medium');
  assert.deepEqual(catalog.reasoning.options.map((item) => item.id), ['medium', 'max']);
});

test('shared ACP discovery refreshes model-dependent settings without applying user effort', async () => {
  const catalog = await discoverAcpRuntimeCatalog('opencode', {
    configuration: {
      cliCommand: process.execPath,
      cliArgs: [acpConfigFixture],
      primary: { modelID: 'provider/model-b' },
      primaryEffort: 'max',
    },
  });
  assert.equal(catalog.defaultModel, 'provider/model-a');
  assert.equal(catalog.currentModel, 'provider/model-b');
  assert.equal(catalog.reasoning.currentValue, 'medium');
  assert.deepEqual(catalog.reasoning.options.map((item) => item.id), ['medium', 'max']);
});

test('candidate model refresh is read-only and drops the old explicit effort before ACP discovery', async () => {
  let discoveryConfiguration;
  const catalog = await fetchProviderModelCatalog({
    providerID: 'opencode',
    model: 'provider/model-a',
    primary: { modelID: 'provider/model-a', variant: 'high' },
    primaryEffort: 'high',
  }, {
    model: 'provider/model-b',
    acpDiscover: async (_providerID, options) => {
      discoveryConfiguration = options.configuration;
      return {
        models: [{ id: 'provider/model-a', label: 'Model A' }, { id: 'provider/model-b', label: 'Model B' }],
        defaultModel: 'provider/model-a',
        currentModel: 'provider/model-b',
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

test('Antigravity model command parser uses advertised slugs without choosing a default', async () => {
  const catalog = await discoverAntigravityModels({ command: 'agy', envOverride: 'CUPPET_ANTIGRAVITY_BIN' }, {
    runImpl: async () => ({ stdout: 'gemini-3.8-flash-high     Gemini 3.8 Flash (High)\nclaude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)\n' }),
  });
  assert.deepEqual(catalog.models.map((item) => item.id), ['gemini-3.8-flash-high', 'claude-sonnet-4-6']);
  assert.equal(catalog.defaultModel, null);
});

test('shared ACP session parser exposes provider reasoning levels without guessing', () => {
  const capabilities = capabilitiesFromAcpSession({
    configOptions: [
      { id: 'model', category: 'model', type: 'select', currentValue: 'provider/model-x', options: [{ value: 'provider/model-x', name: 'Model X' }] },
      { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'medium', options: [
        { value: 'minimal', name: 'Minimal' }, { value: 'medium', name: 'Medium' }, { value: 'xhigh', name: 'Extra High' },
      ] },
    ],
  });
  const catalog = catalogFromAcpCapabilities('opencode', capabilities);
  assert.equal(catalog.reasoning.configId, 'effort');
  assert.equal(catalog.reasoning.currentValue, 'medium');
  assert.deepEqual(catalog.reasoning.options.map((item) => item.id), ['minimal', 'medium', 'xhigh']);
});

test('provider model catalog preserves injected ACP reasoning metadata', async () => {
  const catalog = await fetchProviderModelCatalog({ providerID: 'opencode', model: 'provider/model-x' }, {
    acpDiscover: async (_providerID, options) => {
      assert.equal(options.configuration.model, 'provider/model-x');
      return {
        models: [{ id: 'provider/model-x', label: 'Model X' }],
        currentModel: 'provider/model-x',
        reasoning: { configId: 'effort', currentValue: 'high', options: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] },
      };
    },
  });
  assert.equal(catalog.modelDependentSettings, true);
  assert.equal(catalog.reasoning.configId, 'effort');
  assert.deepEqual(catalog.reasoning.options.map((item) => item.id), ['low', 'high']);
});
