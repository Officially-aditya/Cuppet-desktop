import test from 'node:test';
import assert from 'node:assert/strict';
import { providerPreset, providerPresetList } from '../src/main/provider-presets.mjs';

test('simple provider settings advertise the seven pinned providers', () => {
  const presets = providerPresetList();
  assert.deepEqual(presets.map((item) => item.id), [
    'openai',
    'anthropic',
    'qwen',
    'deepseek',
    'google',
    'meta',
    'openrouter',
  ]);

  for (const preset of presets) {
    assert.match(preset.baseUrl, /^https:\/\//);
    assert.ok(preset.model);
    assert.ok(preset.authLabel);
  }
});

test('OpenRouter uses the official OpenAI-compatible API and Auto Router', () => {
  assert.deepEqual(providerPreset('openrouter'), {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openrouter/auto',
    authLabel: 'OpenRouter API key',
    note: 'Uses OpenRouter Auto so model routing stays current without another model setting.',
  });
});

test('provider lookup is case-insensitive and unknown values are rejected', () => {
  assert.equal(providerPreset('OPENAI')?.id, 'openai');
  assert.equal(providerPreset('unknown-provider'), null);
});
