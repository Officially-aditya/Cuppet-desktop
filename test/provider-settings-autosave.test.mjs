import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('provider settings apply changes immediately and expose Reset instead of Save/Cancel', async () => {
  const source = await readFile(new URL('../src/renderer/react/SettingsModal.tsx', import.meta.url), 'utf8');
  assert.match(source, /const activateProvider = async/);
  assert.match(source, /onBlur=\{\(\) => void onApiKeyCommit\(\)\}/);
  assert.match(source, />\{busy \? 'Applying…' : 'Reset'\}<\/button>/);
  assert.doesNotMatch(source, />Cancel<\/button><button type="submit"[^>]*>Save<\/button>/);
  assert.doesNotMatch(source, /const save = async \(event: React\.FormEvent\)/);
  assert.match(source, /resolveDefault: true/);
  assert.doesNotMatch(source, /Save \${providerLabel} first/);
});

test('local CLI connect/reset preserves provider-owned default alias instead of silently pinning the discovered model', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8');
  assert.match(source, /const resetToProviderDefault = source\.resolveDefault === true && !explicitModel && preset\?\.authType === 'local-cli'/);
  assert.match(source, /model: defaultModel, backgroundModel: defaultModel, secondaryAuto: true/);
  assert.doesNotMatch(source, /const exactDefault/);
  assert.doesNotMatch(source, /advertised\?\.defaultModel/);
});
