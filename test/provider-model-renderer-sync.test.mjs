import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('composer model picker listens for provider settings changes and requests live catalog', async () => {
  const picker = await readFile(new URL('../src/renderer/react/ModelPicker.tsx', import.meta.url), 'utf8');
  const modal = await readFile(new URL('../src/renderer/react/SettingsModal.tsx', import.meta.url), 'utf8');
  assert.match(picker, /PROVIDER_SETTINGS_EVENT/);
  assert.match(picker, /window\.cuppet\.settings\.models\(\)/);
  assert.match(modal, /notifyProviderSettingsChanged\(\)/);
});


test('ModelPicker reads ACP-advertised reasoning options', async () => {
  const source = await readFile(new URL('../src/renderer/react/ModelPicker.tsx', import.meta.url), 'utf8');
  assert.match(source, /advertised\.reasoning/);
  assert.match(source, /settings\?\.primaryEffort/);
});
