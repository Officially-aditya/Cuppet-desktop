import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDER_OVERRIDES,
  buildProviderCatalog,
  integrationMatchesProvider,
  modelMatchesProvider,
  modelSupportsCodingAgent,
  modelsForProvider,
  resolveLiveModelRef,
  missingCodingAgentCapabilities,
} from '../src/runtime/provider-catalog.mjs';

const model = (providerID, modelID, { tools = true, streaming = true, input = ['text'], output = ['text'], enabled = true, status = 'active' } = {}) => ({
  providerID, modelID, name: modelID, context: 128000, outputLimit: 8192, enabled, status,
  capabilities: { tools, streaming, input, output },
});
const integration = (id, name = id) => ({ id, name });

test('provider catalog groups Azure/OpenAI and Vertex variants without crossing vendors', () => {
  const models = [
    model('anthropic', 'claude-test'),
    model('azure', 'azure-coder'),
    model('openai', 'gpt-coder'),
    model('google', 'gemini-api'),
    model('google-vertex', 'gemini-vertex'),
    model('google-vertex-anthropic', 'claude-vertex'),
  ];
  const catalog = buildProviderCatalog(models, [integration('azure-openai'), integration('google-vertex')]);
  const openai = catalog.find((provider) => provider.id === 'openai');
  const vertex = catalog.find((provider) => provider.id === 'vertex');
  assert.deepEqual(openai.integrationIds, ['openai', 'azure', 'azure-openai']);
  assert.equal(modelMatchesProvider({ providerID: 'azure' }, openai), true);
  assert.equal(modelMatchesProvider({ providerID: 'anthropic' }, openai), false);
  assert.equal(integrationMatchesProvider({ id: 'azure-openai' }, openai), true);
  assert.equal(vertex.specialization, 'vertex');
  assert.deepEqual(modelsForProvider(models, 'vertex').map((item) => item.providerID), ['google-vertex', 'google-vertex-anthropic']);
  assert.equal(modelMatchesProvider({ providerID: 'google' }, vertex), false);
  assert.equal(PROVIDER_OVERRIDES.nvidia, undefined);
});

test('unknown future providers and NVIDIA are discovered dynamically', () => {
  const catalog = buildProviderCatalog([
    model('future-provider', 'future-coder'),
    model('nvidia', 'nim-coder'),
    model('nvidia', 'nim-image', { input: ['image'], output: ['image'] }),
  ], [integration('future-provider', 'Future Provider'), integration('nvidia', 'NVIDIA')]);
  const future = catalog.find((provider) => provider.id === 'future-provider');
  const nvidia = catalog.find((provider) => provider.id === 'nvidia');
  assert.equal(future.label, 'Future Provider');
  assert.equal(future.capabilities.codingAgent, true);
  assert.equal(nvidia.label, 'NVIDIA');
  assert.deepEqual(modelsForProvider([
    model('nvidia', 'nim-coder'),
    model('nvidia', 'nim-no-tools', { tools: false }),
  ], nvidia).map((item) => item.modelID), ['nim-coder']);
});

test('coding-agent capability requires text input/output, streaming, and tools', () => {
  assert.equal(modelSupportsCodingAgent(model('p', 'ok')), true);
  assert.equal(modelSupportsCodingAgent(model('p', 'no-tools', { tools: false })), false);
  assert.equal(modelSupportsCodingAgent(model('p', 'no-stream', { streaming: false })), false);
  assert.equal(modelSupportsCodingAgent(model('p', 'image', { input: ['image'], output: ['text'] })), false);
  const [provider] = buildProviderCatalog([model('text-only', 'm', { tools: false })], [integration('text-only')]);
  assert.deepEqual(missingCodingAgentCapabilities(provider), ['tool calling']);
});

test('legacy provider aliases resolve to exact live model IDs without guessing another model', () => {
  const models = [
    model('google-vertex', 'gemini-test'),
    model('google', 'gemini-test'),
    model('openai', 'gpt-test'),
  ];
  assert.deepEqual(resolveLiveModelRef({ providerID: 'vertex', modelID: 'gemini-test', variant: 'high' }, models), {
    providerID: 'google-vertex', modelID: 'gemini-test', variant: 'high',
  });
  assert.deepEqual(resolveLiveModelRef({ providerID: 'openai', modelID: 'gpt-test' }, models), { providerID: 'openai', modelID: 'gpt-test' });
  assert.equal(resolveLiveModelRef({ providerID: 'vertex', modelID: 'missing' }, models), null);
});
