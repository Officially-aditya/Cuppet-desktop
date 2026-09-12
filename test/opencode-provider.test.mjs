import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { fetchProviderModelCatalog } from '../src/main/provider-model-catalog.mjs';
import { classifyProviderError } from '../src/runtime/provider-error.mjs';
import { OpenCodeServerProvider, discoverOpenCodeModels, opencodeBackendDefinition } from '../src/runtime/providers/backends/opencode.mjs';
import { localCliDescriptor } from '../src/runtime/local-cli-descriptors.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-opencode-server.mjs', import.meta.url));

function provider(prompt = 'Hello OpenCode.') {
  return new OpenCodeServerProvider({
    providerID: 'opencode',
    cliCommand: process.execPath,
    cliArgs: [fixture],
    primary: { providerID: 'opencode', modelID: 'anthropic/test-model', variant: 'high' },
  });
}

function streamOptions() {
  return {
    projectRoot: tmpdir(),
    tools: [{ type: 'function', function: { name: 'workspace_read', description: 'Read workspace', parameters: { type: 'object', properties: {} } } }],
    executeTool: async () => ({ success: true, output: 'fixture', contentItems: [] }),
  };
}

test('OpenCode uses managed serve/http transport with Cuppet-owned execution authority', async () => {
  let streamed = '';
  const options = streamOptions();
  options.onDelta = async (delta) => { streamed += delta; };
  const result = await provider().stream([{ role: 'user', content: 'Hello OpenCode.' }], options);
  assert.equal(result.text, 'OpenCode ready.');
  assert.equal(streamed, 'OpenCode ready.');
  assert.equal(result.usage.inputTokens, 3);
  assert.equal(result.usage.outputTokens, 2);
  assert.equal(result.usage.cachedInputTokens, 1);
  assert.equal(result.usage.reasoningTokens, 1);
});

test('OpenCode preserves structured provider auth failures instead of replacing them with an empty-response error', async () => {
  let failure;
  try {
    await provider().stream([{ role: 'user', content: 'TRIGGER_PROVIDER_AUTH_ERROR' }], streamOptions());
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error);
  assert.equal(failure.name, 'ProviderAuthError');
  assert.match(failure.message, /Missing provider credentials/i);
  assert.doesNotMatch(failure.message, /completed without a user-visible response/i);
  const classified = classifyProviderError(failure, { providerID: 'opencode' });
  assert.equal(classified.category, 'authentication');
  assert.equal(classified.action, 'reauthenticate');
});

test('OpenCode preserves structured provider HTTP status for generic provider classification', async () => {
  let failure;
  try {
    await provider().stream([{ role: 'user', content: 'TRIGGER_API_ERROR' }], streamOptions());
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error);
  assert.equal(failure.name, 'APIError');
  assert.equal(failure.status, 429);
  assert.match(failure.message, /Rate limit exceeded/i);
  const classified = classifyProviderError(failure, { providerID: 'opencode' });
  assert.equal(classified.category, 'rate_limit');
});

test('OpenCode model discovery keeps provider-advertised variants from verbose inventory', async () => {
  const catalog = await discoverOpenCodeModels(localCliDescriptor('opencode'), {
    configuration: { cliCommand: process.execPath, cliArgs: [fixture] },
  });
  assert.equal(catalog.available, true);
  assert.deepEqual(catalog.models.map((model) => model.id), ['anthropic/test-model', 'openai/test-model']);
  assert.deepEqual(catalog.models[0].variants, ['low', 'medium', 'high']);
  assert.equal(catalog.models[0].context, 200000);
  assert.equal(catalog.models[0].outputLimit, 64000);
});

test('OpenCode capability discovery exposes effort for the selected model', async () => {
  const backend = opencodeBackendDefinition();
  const capabilities = await backend.operations.discoverCapabilities({
    configuration: {
      providerID: 'opencode',
      cliCommand: process.execPath,
      cliArgs: [fixture],
      primary: { providerID: 'opencode', modelID: 'anthropic/test-model', variant: 'high' },
    },
  });
  assert.equal(capabilities.modelDependentSettings, true);
  assert.equal(capabilities.currentModel, 'anthropic/test-model');
  assert.equal(capabilities.reasoning.configId, 'variant');
  assert.equal(capabilities.reasoning.currentValue, 'high');
  assert.deepEqual(capabilities.reasoning.options.map((item) => item.id), ['low', 'medium', 'high']);
});

test('OpenCode effort survives the main-process model catalog projection', async () => {
  const catalog = await fetchProviderModelCatalog({
    providerID: 'opencode',
    cliCommand: process.execPath,
    cliArgs: [fixture],
    primary: { providerID: 'opencode', modelID: 'anthropic/test-model', variant: 'high' },
    primaryEffort: 'high',
  });
  assert.equal(catalog.source, 'opencode-http');
  assert.equal(catalog.modelDependentSettings, true);
  assert.equal(catalog.configuredModel, 'anthropic/test-model');
  assert.equal(catalog.reasoning.currentValue, 'high');
  assert.deepEqual(catalog.reasoning.options.map((item) => item.id), ['low', 'medium', 'high']);
});
