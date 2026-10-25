import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { providerRequest, serializableProviderConfiguration } from '../src/runtime/provider-policy.mjs';

const source = await readFile(new URL('../src/main/provider-settings.mjs', import.meta.url), 'utf8');

test('provider-managed auth does not query Electron safeStorage just to render settings', () => {
  assert.match(source, /externalCredentialProvider \? null : this\.#credentialStorageStatus\(this\.#safeStorage\)/);
  assert.match(source, /encryptionBackend: externalCredentialProvider \? 'provider-managed'/);
  assert.match(source, /\['chatgpt', 'local-cli'\]\.includes\(selectedPreset\?\.authType\) \? '' : this\.#decryptApiKey\(\)/);
});

test('API-key credential access remains injectable and lazy', () => {
  assert.match(source, /constructor\(path, \{ safeStorageImpl = safeStorage, credentialStorageStatusImpl = credentialStorageStatus \} = \{\}\)/);
  assert.match(source, /if \(!this\.#encryptedApiKey\) return '';/);
  assert.match(source, /this\.#safeStorage\.encryptString/);
  assert.match(source, /this\.#safeStorage\.decryptString/);
});

test('serializable model metadata excludes credentials while execution retains host authentication and safe options', () => {
  const key = 'provider-metadata-canary';
  const configuration = { providerID: 'openai-compatible', apiKey: key, model: 'model-test', models: [{
    providerID: 'openai-compatible', modelID: 'model-test', capabilities: { tools: true, streaming: true, input: ['text'], output: ['text'] },
    request: { headers: { 'x-api-key': key, 'x-goog-api-key': key, 'x-request-tag': 'safe' }, body: { token: key, secret: key, max_tokens: 1024, temperature: 0.2 } },
    variants: [{ id: 'high', body: { reasoning: { effort: 'high' }, cookie: key } }],
  }] };
  const serialized = serializableProviderConfiguration(configuration);
  assert.ok(!JSON.stringify(serialized).includes(key));
  const request = providerRequest(configuration);
  assert.equal(request.apiKey, key);
  assert.deepEqual(request.requestHeaders, { 'x-request-tag': 'safe' });
  assert.deepEqual(request.requestBody, { max_tokens: 1024, temperature: 0.2 });
});
