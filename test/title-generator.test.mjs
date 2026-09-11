import assert from 'node:assert/strict';
import test from 'node:test';
import { generateChatTitle, sanitizeChatTitle, secondaryProviderConfiguration } from '../src/runtime/title-generator.mjs';

test('chat title query uses the configured secondary API model', async () => {
  let seenConfig = null;
  let seenMessages = null;
  const providerConfig = {
    providerID: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'test-key',
    models: [
      { providerID: 'openai', modelID: 'primary', capabilities: { tools: true, streaming: true, input: ['text'], output: ['text'] } },
      { providerID: 'openai', modelID: 'secondary', capabilities: { tools: true, streaming: true, input: ['text'], output: ['text'] } },
    ],
    primary: { providerID: 'openai', modelID: 'primary' },
    secondary: { providerID: 'openai', modelID: 'secondary' },
  };
  const title = await generateChatTitle({
    providerConfig,
    userText: 'Please fix the composer height after pasting several lines',
    providerFactory(config) {
      seenConfig = config;
      return { async stream(messages, options) { seenMessages = messages; await options.onDelta('Fix Composer Height'); return { text: 'Fix Composer Height' }; } };
    },
  });
  assert.equal(seenConfig.model, 'secondary');
  assert.equal(title, 'Fix Composer Height');
  assert.match(seenMessages[0].content, /2-6 words/);
});

test('account-backed providers project the secondary selection into the title request', () => {
  const result = secondaryProviderConfiguration({
    providerID: 'codex',
    primary: { providerID: 'codex', modelID: 'primary-model' },
    secondary: { providerID: 'codex', modelID: 'secondary-model', variant: 'low' },
  });
  assert.equal(result.providerID, 'codex');
  assert.equal(result.model, 'secondary-model');
  assert.equal(result.primary.modelID, 'secondary-model');
  assert.equal(result.primaryEffort, 'low');
});

test('title sanitizer removes model formatting and bounds noisy output', () => {
  assert.equal(sanitizeChatTitle('**Title: Browser Control Integration.**'), 'Browser Control Integration');
  assert.equal(sanitizeChatTitle('```text\nProvider Error Handling\n```'), 'Provider Error Handling');
  assert.equal(sanitizeChatTitle(''), null);
});
