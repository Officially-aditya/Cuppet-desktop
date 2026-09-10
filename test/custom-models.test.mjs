import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CUSTOM_MODEL_PROBE_PROMPT,
  addCustomModelToRegistry,
  customModelEntries,
  normalizeCustomModelID,
  normalizeCustomModelRegistry,
  probeCustomModel,
} from '../src/main/custom-models.mjs';

test('custom model registry stays provider scoped and deduplicated', () => {
  const registry = addCustomModelToRegistry(
    addCustomModelToRegistry({}, 'openai', 'custom/a'),
    'anthropic',
    'custom/a',
  );
  const repeated = addCustomModelToRegistry(registry, 'openai', 'custom/a');
  assert.deepEqual(repeated, { openai: ['custom/a'], anthropic: ['custom/a'] });
  assert.deepEqual(customModelEntries(repeated), [
    { providerID: 'openai', modelID: 'custom/a' },
    { providerID: 'anthropic', modelID: 'custom/a' },
  ]);
});

test('custom model registry sanitizes persisted values', () => {
  assert.deepEqual(normalizeCustomModelRegistry({ openai: ['valid', 'valid', 'bad id', '', 42], 'bad provider': ['ignored'] }), { openai: ['valid'] });
  assert.equal(normalizeCustomModelID('  org/model-v1  '), 'org/model-v1');
  assert.throws(() => normalizeCustomModelID('bad model'), /unsupported whitespace/i);
});

test('custom model probe sends one tiny tool-free request to the requested model', async () => {
  let captured;
  const providerFactory = (configuration) => ({
    async stream(messages, options) {
      captured = { configuration, messages, options };
      await options.onDelta('OK');
      return { text: 'OK', toolCalls: [], usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } };
    },
  });

  const result = await probeCustomModel({
    providerID: 'openai-compatible',
    baseUrl: 'https://example.test/v1',
    apiKey: 'secret',
    model: 'base-model',
    backgroundModel: 'base-model',
  }, 'org/custom-model', { providerFactory, timeoutMs: 1_000 });

  assert.equal(result.ok, true);
  assert.equal(result.modelID, 'org/custom-model');
  assert.equal(captured.configuration.model, 'org/custom-model');
  assert.deepEqual(captured.messages, [{ role: 'user', content: CUSTOM_MODEL_PROBE_PROMPT }]);
  assert.deepEqual(captured.options.tools, []);
  assert.equal(captured.options.signal instanceof AbortSignal, true);
});

test('custom model probe does not accept an empty provider response', async () => {
  const providerFactory = () => ({ stream: async () => ({ text: '', toolCalls: [], usage: null }) });
  await assert.rejects(
    probeCustomModel({ providerID: 'openai-compatible', baseUrl: 'https://example.test/v1', apiKey: 'secret', model: 'base' }, 'custom-empty', { providerFactory, timeoutMs: 1_000 }),
    /returned no text/i,
  );
});
