import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverAntigravityModels, parseAntigravityModelOutput } from '../src/main/provider-model-catalog.mjs';

test('Antigravity parser accepts current tab-separated model rows', () => {
  const models = parseAntigravityModelOutput([
    'Fetching available models...',
    'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
    'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
    'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
  ].join('\n'));

  assert.deepEqual(models, [
    { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
    { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
  ]);
});

test('Antigravity parser keeps the older aligned-column output compatible', () => {
  const models = parseAntigravityModelOutput([
    'gemini-3.7-flash-high     Gemini 3.7 Flash (High)',
    'claude-opus-4-6           Claude Opus 4.6 (Thinking)',
  ].join('\n'));

  assert.deepEqual(models, [
    { id: 'gemini-3.7-flash-high', label: 'Gemini 3.7 Flash (High)' },
    { id: 'claude-opus-4-6', label: 'Claude Opus 4.6 (Thinking)' },
  ]);
});

test('Antigravity parser accepts legacy bare slugs without admitting progress text', () => {
  const models = parseAntigravityModelOutput([
    'Fetching available models...',
    'gemini-3.6-flash-low',
    'gpt-oss-120b-medium',
  ].join('\n'));

  assert.deepEqual(models, [
    { id: 'gemini-3.6-flash-low', label: 'gemini-3.6-flash-low' },
    { id: 'gpt-oss-120b-medium', label: 'gpt-oss-120b-medium' },
  ]);
});

test('Antigravity discovery invokes the authoritative models subcommand', async () => {
  const calls = [];
  const catalog = await discoverAntigravityModels({ command: 'agy', envOverride: 'CUPPET_ANTIGRAVITY_BIN' }, {
    runImpl: async (command, args, timeout) => {
      calls.push({ command, args, timeout });
      return { stdout: 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n', stderr: '' };
    },
  });

  assert.equal(catalog.available, true);
  assert.deepEqual(catalog.models, [{ id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' }]);
  assert.equal(catalog.defaultModel, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'agy');
  assert.deepEqual(calls[0].args, ['models']);
});
