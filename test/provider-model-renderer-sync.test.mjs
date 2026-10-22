import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadModule } from './helpers/load-tsx.mjs';

for (const [name, explicit, variants, liveDefault, expected, props] of [
  ['explicit effort', 'xhigh', ['low', 'xhigh'], '', 'Extra High', {}],
  ['provider default', '', ['low', 'high'], 'high', 'High', {}],
  ['automatic effort', 'default', ['low', 'high'], '', 'Default', {}],
  ['no effort support', '', [], '', null, {}],
  ['automatic secondary model', 'high', ['low', 'high'], '', null, { slot: 'secondary' }],
]) {
  test(`model trigger displays the current effort: ${name}`, () => {
    const settings = {
      providerID: 'test',
      primary: { providerID: 'test', modelID: 'model', variant: explicit },
      primaryEffort: explicit,
      models: [{ providerID: 'test', modelID: 'model', variants }],
    };
    const catalog = {
      providerID: 'test', available: true, configuredModel: 'model', models: [{ id: 'model', label: 'Test model' }],
      ...(liveDefault ? { modelDependentSettings: true, reasoning: { options: variants.map(id => ({ id })), currentValue: liveDefault } } : {}),
    };
    const { ModelPicker } = loadModule(fileURLToPath(new URL('../src/renderer/react/ModelPicker.tsx', import.meta.url)), {
      './client-provider-state': { useClientProviderSettings: () => settings },
      './model-catalog-cache': { cachedModelCatalog: () => catalog, cachedProviderCatalog: () => catalog },
      './model-pins': { usePinnedModels: () => [], orderPinnedModels: (options) => options },
      './provider-settings-events': {},
    });
    const html = renderToStaticMarkup(createElement(ModelPicker, props));
    if (expected) {
      assert.match(html, new RegExp(`class="model-picker-effort">· ${expected}</span>`));
      assert.ok(html.includes(`Effort: ${expected}`));
    } else {
      assert.doesNotMatch(html, /class="model-picker-effort"/);
    }
  });
}

test('composer model picker consumes shared provider settings and requests generic live catalog', async () => {
  const picker = await readFile(new URL('../src/renderer/react/ModelPicker.tsx', import.meta.url), 'utf8');
  const providerState = await readFile(new URL('../src/renderer/react/client-provider-state.ts', import.meta.url), 'utf8');
  const modal = await readFile(new URL('../src/renderer/react/SettingsModal.tsx', import.meta.url), 'utf8');
  const catalogCache = await readFile(new URL('../src/renderer/react/model-catalog-cache.ts', import.meta.url), 'utf8');
  assert.match(picker, /useClientProviderSettings\(\)/);
  assert.match(picker, /refreshClientProviderSettings\(\)/);
  assert.doesNotMatch(picker, /window\.cuppet\.settings\.get\(\)/);
  assert.match(providerState, /PROVIDER_SETTINGS_EVENT/);
  assert.match(providerState, /window\.cuppet\.settings\.get\(\)/);
  assert.match(picker, /loadModelCatalog\(/);
  assert.match(catalogCache, /window\.cuppet\.settings\.models\(\)/);
  assert.doesNotMatch(picker, /codexAuth\.models/);
  assert.match(modal, /notifyProviderSettingsChanged\(\)/);
});

test('ModelPicker resolves cached or live model-dependent capabilities before deciding effort and persisting', async () => {
  const picker = await readFile(new URL('../src/renderer/react/ModelPicker.tsx', import.meta.url), 'utf8');
  const start = picker.indexOf('const chooseModel = async');
  const end = picker.indexOf('const chooseEffort = async');
  assert.ok(start >= 0 && end > start);
  const chooseModel = picker.slice(start, end);
  const refresh = chooseModel.indexOf('loadModelCatalog(current, { model: id })');
  const effort = chooseModel.indexOf('const nextEffortState = modelEffortState');
  const save = chooseModel.indexOf('window.cuppet.settings.save');
  assert.ok(refresh >= 0, 'candidate model capabilities must be loaded from cache or the provider');
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
  assert.match(preload, /cuppet:settings:models/);
  assert.match(preload, /settings\.models/);
  assert.match(main, /handle\('settings\.models',[\s\S]*request\('provider\.models', \{/);
  assert.match(main, /provider: settings\.runtimeValue\(\)/);
  assert.match(main, /model: value && typeof value === 'object'/);
  assert.doesNotMatch(main, /fetchProviderModelCatalog/);
  assert.match(runtime, /case 'provider\.models': return providerControl\.models\(boundedProvider\(params\.provider\), \{\s*model: typeof params\.model === 'string' \? params\.model\.slice\(0, 1000\) : '',\s*refresh: params\.refresh === true,/);
  const apiTypes = await readFile(new URL('../src/renderer/ipc-api.d.ts', import.meta.url), 'utf8');
  assert.match(apiTypes, /models: \(options\?: Record<string, unknown>\) => Promise<Types\.ProviderModelCatalog>/);
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

test('credential and account changes invalidate the persisted catalog instead of waiting for its freshness window', async () => {
  const [picker, modal, events, cache] = await Promise.all([
    readFile(new URL('../src/renderer/react/ModelPicker.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/react/SettingsModal.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/react/provider-settings-events.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/react/model-catalog-cache.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(events, /PROVIDER_CATALOG_INVALID_EVENT/);
  assert.match(cache, /export function invalidateModelCatalogCache/);
  assert.match(cache, /export function isProviderCatalogStale/);
  assert.match(picker, /isProviderCatalogStale\(settings\)/);
  assert.match(picker, /window\.addEventListener\(PROVIDER_CATALOG_INVALID_EVENT/);
  assert.match(picker, /window\.setInterval\(\(\) => revalidate\(false\), CATALOG_FRESH_MS\)/);
  assert.match(modal, /invalidateModelCatalogCache\(\)/);
  assert.match(modal, /notifyProviderCatalogInvalid\(\)/);
  const accountFlow = modal.slice(modal.indexOf('const connectCodex'), modal.indexOf('const connectLocalCli'));
  assert.match(accountFlow, /watchCodexLogin\(\)/, 'ChatGPT sign-in completion does not revalidate the catalog');
  assert.match(accountFlow, /invalidateModelCatalogs\(\)/, 'signing out of the account does not revalidate the catalog');
});
