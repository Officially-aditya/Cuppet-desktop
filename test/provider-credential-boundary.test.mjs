import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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
