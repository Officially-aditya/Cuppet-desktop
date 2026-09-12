import test from 'node:test';
import assert from 'node:assert/strict';
import { providerPreset, providerPresetList } from '../src/main/provider-presets.mjs';

const EXPECTED_PROVIDER_IDS = [
  'codex',
  'opencode',
  'claude-code',
  'grok-build',
  'antigravity',
  'github-copilot',
  'mistral-vibe',
  'kiro',
  'openai',
  'anthropic',
  'qwen',
  'deepseek',
  'kimi',
  'zai',
  'google',
  'meta',
  'openrouter',
];

test('simple provider settings advertise the current pinned provider surface', () => {
  const presets = providerPresetList();
  assert.deepEqual(presets.map((item) => item.id), EXPECTED_PROVIDER_IDS);

  for (const preset of presets) {
    assert.match(preset.baseUrl, /^(?:https|cli|codex):\/\//);
    assert.ok(preset.model);
    assert.ok(['api-key', 'local-cli', 'chatgpt'].includes(preset.authType));
    assert.ok(preset.authLabel);
    assert.ok(Array.isArray(preset.models));
  }
});

test('OpenRouter uses the official OpenAI-compatible API and Auto Router', () => {
  const preset = providerPreset('openrouter');
  assert.ok(preset);
  assert.equal(preset.id, 'openrouter');
  assert.equal(preset.label, 'OpenRouter');
  assert.equal(preset.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(preset.model, 'openrouter/auto');
  assert.equal(preset.authType, 'api-key');
  assert.equal(preset.authLabel, 'OpenRouter API key');
  assert.deepEqual(preset.models, [
    {
      id: 'openrouter/auto',
      label: 'OpenRouter Auto',
      description: 'Lets OpenRouter route each request to a current compatible model.',
    },
  ]);
  assert.equal(preset.note, 'Uses OpenRouter Auto so model routing stays current without another model setting.');
});

test('provider lookup is case-insensitive and unknown values are rejected', () => {
  assert.equal(providerPreset('OPENAI')?.id, 'openai');
  assert.equal(providerPreset('unknown-provider'), null);
});
