import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const sources = await Promise.all(['ModelPicker', 'SettingsModal'].map(async (name) => [
  name,
  ts.transpileModule(await readFile(new URL('../src/renderer/react/' + name + '.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText,
]));
const compiled = Object.fromEntries(sources);
const settings = (providerID) => ({
  providerID, baseUrl: '', primary: { providerID, modelID: 'model-a' },
  presets: ['opencode', 'antigravity'].map((id) => ({ id, label: id, authType: 'local-cli', model: 'model-a' })),
});

function component(name, modules, globals) {
  const slots = [], effects = [];
  let index = 0;
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, i) => value === b[i]);
  const react = {
    useState(initial) {
      const i = index++;
      if (!slots[i]) slots[i] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[i].value, (value) => { slots[i].value = typeof value === 'function' ? value(slots[i].value) : value; }];
    },
    useRef(initial) { const i = index++; return slots[i] ??= { current: initial }; },
    useMemo(compute, deps) {
      const i = index++;
      if (!sameDeps(slots[i]?.deps, deps)) slots[i] = { value: compute(), deps };
      return slots[i].value;
    },
    useCallback(callback, deps) { return react.useMemo(() => callback, deps); },
    useEffect(effect, deps) {
      const i = index++;
      if (sameDeps(slots[i]?.deps, deps)) return;
      slots[i]?.cleanup?.();
      slots[i] = { deps };
      effects.push(() => { slots[i].cleanup = effect(); });
    },
  };
  const jsx = (type, props) => ({ type, props });
  const exports = {};
  vm.runInNewContext(compiled[name], {
    exports, ...globals,
    require: (id) => id === 'react' ? react : id === 'react/jsx-runtime' ? { jsx, jsxs: jsx } : modules[id] ?? {},
  });
  return {
    render(props = {}) { index = 0; return exports[name](props); },
    async flush() { while (effects.length) effects.shift()(); await new Promise((resolve) => setImmediate(resolve)); },
    close() { for (const slot of slots) slot?.cleanup?.(); },
  };
}
function nodes(node) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  return [node, ...nodes(node.props?.children)];
}

test('switching back renders cached model and effort choices without another ACP discovery', async (t) => {
  const previous = { window: globalThis.window, localStorage: globalThis.localStorage };
  let active = settings('opencode'), calls = 0;
  const localStorage = { getItem: () => null, setItem: () => {} };
  const window = {
    setInterval: () => 1, clearInterval: () => {}, addEventListener: () => {}, removeEventListener: () => {},
    cuppet: { settings: { models: async () => {
      calls++;
      return { providerID: active.providerID, source: 'acp', available: true, models: [{ id: 'model-a' }],
        configuredModel: 'model-a', modelDependentSettings: true,
        reasoning: { configId: 'effort', currentValue: 'high', options: [{ id: 'high' }] } };
    } } },
  };
  globalThis.window = window;
  globalThis.localStorage = localStorage;
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  } });
  const source = stripTypeScriptTypes(await readFile(new URL('../src/renderer/react/model-catalog-cache.ts', import.meta.url), 'utf8'));
  const cache = await import('data:text/javascript,' + encodeURIComponent(source));
  await cache.loadModelCatalog(active);
  active = settings('antigravity');
  await cache.loadModelCatalog(active);
  const picker = component('ModelPicker', {
    './model-catalog-cache': cache,
    './client-provider-state': { useClientProviderSettings: () => active },
    './model-pins': { usePinnedModels: () => [], orderPinnedModels: (items) => items },
    './provider-settings-events': {},
  }, { window, localStorage, document: { addEventListener() {}, removeEventListener() {} } });
  t.after(() => picker.close());
  for (const id of ['antigravity', 'opencode', 'antigravity']) {
    active = settings(id);
    picker.render();
    await picker.flush();
    assert.deepEqual(cache.cachedModelCatalog(active).reasoning.options.map((item) => item.id), ['high']);
  }
  assert.equal(calls, 2);
});

test('provider selection preserves catalogs and does not repeat Codex or sandbox probes', async (t) => {
  let active = settings('opencode'), invalidations = 0, codexChecks = 0, sandboxChecks = 0;
  const onError = (error) => { throw error; };
  const window = {
    clearInterval() {}, setInterval: () => 1,
    cuppet: {
      settings: { get: async () => active, save: async ({ providerID }) => (active = settings(providerID)) },
      cliAgents: { status: async (providerID) => ({ providerID, installed: true, connected: true, available: true }) },
      codexAuth: { status: async () => { codexChecks++; return { loggedIn: true }; } },
      sandbox: { status: async () => { sandboxChecks++; return {}; } },
      remote: { devices: async () => [] },
    },
  };
  const modal = component('SettingsModal', {
    './model-catalog-cache': { invalidateModelCatalogCache: () => { invalidations++; } },
    './provider-settings-events': { notifyProviderSettingsChanged() {}, notifyProviderCatalogInvalid() {} },
    './SelectControl': {}, './ModelPicker': {}, './GeneralPanel': {},
  }, { window, localStorage: { getItem: () => null, setItem() {} },
    document: { body: { classList: { toggle() {} } } } });
  t.after(() => modal.close());
  const props = { provider: active, initialSection: 'platform', onError, onSaved() {} };
  let tree = modal.render(props);
  await modal.flush();
  for (const id of ['antigravity', 'opencode', 'antigravity']) {
    await nodes(tree).find((node) => node.props?.onProvider).props.onProvider(id);
    tree = modal.render(props);
    await modal.flush();
  }
  assert.equal(invalidations, 0);
  assert.equal(codexChecks, 1);
  assert.equal(sandboxChecks, 1);
});
