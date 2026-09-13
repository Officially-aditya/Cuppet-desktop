import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('composer model picker listens for provider settings changes and requests generic live catalog', async () => {
  const picker = await readFile(new URL('../src/renderer/react/ModelPicker.tsx', import.meta.url), 'utf8');
  const modal = await readFile(new URL('../src/renderer/react/SettingsModal.tsx', import.meta.url), 'utf8');
  assert.match(picker, /PROVIDER_SETTINGS_EVENT/);
  assert.match(picker, /window\.cuppet\.settings\.models\(\)/);
  assert.doesNotMatch(picker, /codexAuth\.models/);
  assert.match(modal, /notifyProviderSettingsChanged\(\)/);
});

test('ModelPicker refreshes model-dependent capabilities before deciding effort and persisting', async () => {
  const picker = await readFile(new URL('../src/renderer/react/ModelPicker.tsx', import.meta.url), 'utf8');
  const start = picker.indexOf('const chooseModel = async');
  const end = picker.indexOf('const chooseEffort = async');
  assert.ok(start >= 0 && end > start);
  const chooseModel = picker.slice(start, end);
  const refresh = chooseModel.indexOf('window.cuppet.settings.models({ model: id })');
  const effort = chooseModel.indexOf('const nextEffortState = modelEffortState');
  const save = chooseModel.indexOf('window.cuppet.settings.save');
  assert.ok(refresh >= 0, 'candidate model capabilities must be refreshed');
  assert.ok(refresh < effort, 'candidate capabilities must be known before effort is resolved');
  assert.ok(effort < save, 'effort validity must be resolved before settings are persisted');
  assert.match(picker, /if \(exactLiveSnapshot\)/);
  assert.match(picker, /advertised\.modelDependentSettings === true/);
  assert.match(picker, /advertised\.reasoning\?\.options/);
});

test('candidate model refresh crosses preload and main IPC into runtime authority without persisting settings', async () => {
  const preload = await readFile(new URL('../src/preload/preload.cjs', import.meta.url), 'utf8');
  const main = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8');
  const runtime = await readFile(new URL('../src/runtime/main.mjs', import.meta.url), 'utf8');
  const types = await readFile(new URL('../src/renderer/types.ts', import.meta.url), 'utf8');
  assert.match(preload, /models: \(options = \{\}\) => ipcRenderer\.invoke\('cuppet:settings:models', options\)/);
  assert.match(main, /ipcMain\.handle\('cuppet:settings:models',[\s\S]*request\('provider\.models', \{/);
  assert.match(main, /provider: settings\.runtimeValue\(\)/);
  assert.match(main, /model: value && typeof value === 'object'/);
  assert.doesNotMatch(main, /fetchProviderModelCatalog/);
  assert.match(runtime, /case 'provider\.models': return providerControl\.models\(boundedProvider\(params\.provider\), \{ model: params\.model \}\)/);
  assert.match(types, /models: \(options\?: \{ model\?: string \}\) => Promise<ProviderModelCatalog>/);
  assert.match(types, /modelDependentSettings\?: boolean/);
});

test('ModelPicker reads provider-advertised reasoning through the generic catalog', async () => {
  const source = await readFile(new URL('../src/renderer/react/ModelPicker.tsx', import.meta.url), 'utf8');
  assert.match(source, /advertised\.reasoning/);
  assert.match(source, /settings\?\.primaryEffort/);
  assert.match(source, /advertised\.defaultModel/);
  assert.doesNotMatch(source, /CodexModelCatalog/);
});

test('ModelPicker does not branch on provider transport or Codex identity', async () => {
  const source = await readFile(new URL('../src/renderer/react/ModelPicker.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /advertised\.source\s*===/);
  assert.doesNotMatch(source, /providerID\s*===\s*['"]codex['"]/);
  assert.doesNotMatch(source, /configuredModel\s*===\s*['"]codex-default['"]/);
  assert.match(source, /providerPreset\?\.model/);
  assert.match(source, /advertised\.modelDependentSettings === true/);
});
