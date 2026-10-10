import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The store's credential implementation is injectable; stub only Electron's import.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') return { url: 'data:text/javascript,export const safeStorage = {};', shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { ProviderSettingsStore } = await import('../src/main/provider-settings.mjs');
hooks.deregister();

async function fixture(t, initial) {
  const directory = await mkdtemp(join(tmpdir(), 'cuppet-provider-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'settings.json');
  if (initial) await writeFile(path, JSON.stringify(initial));
  const load = async () => {
    const store = new ProviderSettingsStore(path, {
      safeStorageImpl: {},
      credentialStorageStatusImpl: () => ({ available: false, backend: null, reason: 'Test vault unavailable' }),
    });
    await store.load();
    return store;
  };
  return { store: await load(), load, path };
}

test('provider model, effort, and secondary choices survive switching and restart', async (t) => {
  const { store, load, path } = await fixture(t);
  const codex = await store.save({
    providerID: 'codex', model: 'codex-selected', primaryEffort: 'xhigh',
    backgroundModel: 'codex-secondary', secondaryAuto: false,
  });
  const claude = await store.save({
    providerID: 'claude-code', model: 'claude-selected', primaryEffort: 'max',
  });
  const restoredCodex = await store.save({ providerID: 'codex', apiKey: '' });
  assert.deepEqual(restoredCodex.primary, codex.primary);
  assert.deepEqual(restoredCodex.secondary, codex.secondary);
  assert.equal(restoredCodex.primaryEffort, 'xhigh');
  assert.equal(restoredCodex.secondaryAuto, false);
  assert.equal(store.runtimeValue().primaryEffort, 'xhigh');

  const restarted = await load();
  const restoredClaude = await restarted.save({ providerID: 'claude-code', apiKey: '' });
  assert.deepEqual(restoredClaude.primary, claude.primary);
  assert.equal(restoredClaude.primaryEffort, 'max');
  assert.equal(restoredClaude.secondaryAuto, true);
  assert.equal(restoredClaude.secondary.modelID, 'claude-selected');
  assert.equal(restarted.runtimeValue().primaryEffort, 'max');
  const disk = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(disk.providerStates.codex.primaryEffort, 'xhigh');
  assert.equal(disk.providerStates['claude-code'].primaryEffort, 'max');
});

test('legacy active settings are retained when first switching providers', async (t) => {
  const { store, load } = await fixture(t, {
    providerID: 'github-copilot', baseUrl: 'cli://github-copilot',
    model: 'copilot-selected', backgroundModel: 'copilot-secondary',
    primaryEffort: 'high', secondaryAuto: false,
  });
  const fresh = await store.save({ providerID: 'kiro' });
  assert.equal(fresh.primary.modelID, 'cli-default');
  assert.equal(fresh.primaryEffort, null);
  assert.equal(fresh.secondaryAuto, true);
  const restarted = await load();
  const restored = await restarted.save({ providerID: 'github-copilot' });
  assert.equal(restored.primary.modelID, 'copilot-selected');
  assert.equal(restored.secondary.modelID, 'copilot-secondary');
  assert.equal(restored.primaryEffort, 'high');
  assert.equal(restored.secondaryAuto, false);
});

test('explicit defaults overwrite only the chosen provider state', async (t) => {
  const { store, load } = await fixture(t);
  await store.save({ providerID: 'codex', model: 'codex-selected', primaryEffort: 'xhigh' });
  await store.save({ providerID: 'claude-code', model: 'claude-selected', primaryEffort: 'max', secondaryAuto: false });
  const reset = await store.save({
    providerID: 'claude-code', model: 'cli-default', backgroundModel: 'cli-default',
    primaryEffort: '', secondaryEffort: '', secondaryAuto: true,
  });
  assert.equal(reset.primaryEffort, null);
  const restarted = await load();
  const codex = await restarted.save({ providerID: 'codex' });
  assert.equal(codex.primary.modelID, 'codex-selected');
  assert.equal(codex.primaryEffort, 'xhigh');
  const claude = await restarted.save({ providerID: 'claude-code' });
  assert.equal(claude.primary.modelID, 'cli-default');
  assert.equal(claude.primaryEffort, null);
  assert.equal(claude.secondaryAuto, true);
});

test('custom provider endpoint and both advertised efforts survive partial saves and switching', async (t) => {
  const providerID = 'custom-provider';
  const models = ['primary-model', 'secondary-model'].map((modelID) => ({
    providerID, modelID, capabilities: { tools: true, streaming: true, input: ['text'], output: ['text'] },
    variants: { low: { reasoning_effort: 'low' }, high: { reasoning_effort: 'high' } },
  }));
  const { store, load } = await fixture(t, {
    providerID, baseUrl: 'https://provider.example/v1', models, secondaryAuto: false,
    primary: { providerID, modelID: 'primary-model', variant: 'high' },
    secondary: { providerID, modelID: 'secondary-model', variant: 'low' },
  });
  const partial = await store.save({ providerID });
  assert.equal(partial.primary.variant, 'high');
  assert.equal(partial.secondary.variant, 'low');
  await store.save({ providerID: 'codex' });
  const restarted = await load();
  const restored = await restarted.save({ providerID });
  assert.equal(restored.baseUrl, 'https://provider.example/v1');
  assert.deepEqual(restored.primary, partial.primary);
  assert.deepEqual(restored.secondary, partial.secondary);
  assert.equal(restarted.runtimeValue().primary.variant, 'high');
  const cleared = await restarted.save({ primaryEffort: '', secondaryEffort: '' });
  assert.equal(cleared.primary.variant, undefined);
  assert.equal(cleared.secondary.variant, undefined);
});
