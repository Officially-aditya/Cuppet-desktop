import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source = stripTypeScriptTypes(await readFile(new URL('../src/renderer/react/model-catalog-cache.ts', import.meta.url), 'utf8'));
let instance = 0;
const settings = (model = 'a', providerID = 'demo', baseUrl = '') => ({ providerID, baseUrl, primary: { providerID, modelID: model } });
const catalog = (model = 'a', options = ['low', 'high'], providerID = 'demo') => ({ providerID, available: true, source: 'acp', models: [{ id: 'a' }, { id: 'b' }], configuredModel: model, modelDependentSettings: true, reasoning: { configId: 'effort', currentValue: options[0], options: options.map((id) => ({ id })) } });
const load = () => import(`data:text/javascript,${encodeURIComponent(source + '\n// instance ' + instance++)}`);

async function fixture(t, fetch) {
  const previous = { window: globalThis.window, localStorage: globalThis.localStorage };
  let saved = null;
  globalThis.localStorage = { getItem: () => saved, setItem: (_key, value) => { saved = value; } };
  globalThis.window = { cuppet: { settings: { models: fetch } } };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  return { cache: await load(), saved: () => saved };
}

test('previously used models reuse their own advertised efforts and survive an app reload', async (t) => {
  let calls = 0;
  const { cache, saved } = await fixture(t, async (options) => { calls++; return catalog(options?.model || 'a', options?.model === 'b' ? ['medium'] : ['low', 'high']); });
  await cache.loadModelCatalog(settings());
  await cache.loadModelCatalog(settings(), { model: 'b' });
  const a = await cache.loadModelCatalog(settings('a'));
  const b = await cache.loadModelCatalog(settings('b'));
  assert.deepEqual(a.reasoning.options.map((option) => option.id), ['low', 'high']);
  assert.deepEqual(b.reasoning.options.map((option) => option.id), ['medium']);
  assert.equal(calls, 2);
  assert.ok(saved());
  const reloaded = await load();
  assert.deepEqual((await reloaded.loadModelCatalog(settings('b'))).reasoning.options, b.reasoning.options);
  assert.equal(calls, 2);
});

test('cached efforts remain immediately available while a slow refresh is pending', async (t) => {
  let calls = 0;
  let completeRefresh;
  const { cache } = await fixture(t, () => ++calls === 1 ? Promise.resolve(catalog()) : new Promise((resolve) => { completeRefresh = resolve; }));
  await cache.loadModelCatalog(settings());
  const refresh = cache.loadModelCatalog(settings(), { refresh: true });
  const immediate = await Promise.race([
    cache.loadModelCatalog(settings()),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Cached efforts waited on discovery')), 100); timer.unref(); }),
  ]);
  assert.deepEqual(immediate.reasoning.options.map((option) => option.id), ['low', 'high']);
  completeRefresh(catalog('a', ['medium', 'xhigh']));
  await refresh;
  assert.deepEqual(cache.cachedModelCatalog(settings()).reasoning.options.map((option) => option.id), ['medium', 'xhigh']);
});

test('concurrent catalog requests share a single provider discovery', async (t) => {
  let calls = 0;
  let complete;
  const { cache } = await fixture(t, () => { calls++; return new Promise((resolve) => { complete = resolve; }); });
  const first = cache.loadModelCatalog(settings());
  const second = cache.loadModelCatalog(settings());
  assert.equal(calls, 1);
  complete(catalog());
  assert.deepEqual(await first, await second);
});

test('provider and endpoint identities isolate cached model efforts', async (t) => {
  let calls = 0;
  const { cache } = await fixture(t, async () => { calls++; return catalog(); });
  await cache.loadModelCatalog(settings());
  assert.equal(cache.cachedModelCatalog(settings('a', 'other')), null);
  assert.equal(cache.cachedModelCatalog(settings('a', 'demo', 'https://other.example')), null);
  await cache.loadModelCatalog(settings('a', 'demo', 'https://other.example'));
  assert.equal(calls, 2);
  assert.equal(cache.cachedModelCatalog(settings('constructor')), null);
});

test('transient failures are retried and authoritative empty catalogs invalidate old efforts', async (t) => {
  let calls = 0;
  const { cache } = await fixture(t, async () => {
    calls++;
    if (calls === 1) throw new Error('temporary failure');
    if (calls === 3) return { providerID: 'demo', available: false, models: [] };
    return catalog();
  });
  await assert.rejects(cache.loadModelCatalog(settings()), /temporary failure/);
  assert.equal(cache.cachedModelCatalog(settings()), null);
  await cache.loadModelCatalog(settings());
  assert.ok(cache.cachedModelCatalog(settings()));
  await cache.loadModelCatalog(settings(), { refresh: true });
  assert.equal(cache.cachedModelCatalog(settings()), null);
});

test('models with no reasoning options are cached without inventing efforts', async (t) => {
  let calls = 0;
  const { cache } = await fixture(t, async () => { calls++; return { ...catalog(), reasoning: undefined }; });
  await cache.loadModelCatalog(settings());
  assert.equal((await cache.loadModelCatalog(settings())).reasoning, undefined);
  assert.equal(calls, 1);
});

test('a lapsed freshness window revalidates the catalog instead of replaying it forever', async (t) => {
  let calls = 0;
  const { cache } = await fixture(t, async () => { calls++; return catalog(); });
  await cache.loadModelCatalog(settings());
  await cache.loadModelCatalog(settings());
  assert.equal(calls, 1);
  assert.equal(cache.isProviderCatalogStale(settings()), false);
  assert.ok(cache.CATALOG_FRESH_MS > 0);
  await cache.loadModelCatalog(settings(), { maxAgeMs: 0 });
  assert.equal(calls, 2);
  assert.equal(cache.isProviderCatalogStale(settings()), false);
});

test('invalidating one provider catalog keeps other endpoints and forces rediscovery', async (t) => {
  let calls = 0;
  const { cache, saved } = await fixture(t, async () => { calls++; return catalog(); });
  const endpoint = settings('a', 'demo', 'https://b.example');
  await cache.loadModelCatalog(settings());
  await cache.loadModelCatalog(endpoint);
  assert.equal(calls, 2);
  cache.invalidateModelCatalogCache(endpoint);
  assert.ok(cache.cachedModelCatalog(settings()));
  assert.equal(cache.cachedModelCatalog(endpoint), null);
  assert.equal(Object.keys(JSON.parse(saved())).length, 1);
  cache.invalidateModelCatalogCache();
  assert.equal(cache.cachedModelCatalog(settings()), null);
  assert.deepEqual(JSON.parse(saved()), {});
  await cache.loadModelCatalog(settings());
  assert.equal(calls, 3);
});

test('account invalidation prevents an earlier discovery from restoring the old catalog', async (t) => {
  const completions = [];
  const { cache } = await fixture(t, () => new Promise(resolve => completions.push(resolve)));
  const beforeLogout = cache.loadModelCatalog(settings());
  cache.invalidateModelCatalogCache();
  const afterLogin = cache.loadModelCatalog(settings());
  assert.equal(completions.length, 2);
  completions[0](catalog('a', ['old']));
  await beforeLogout;
  assert.equal(cache.cachedModelCatalog(settings()), null);
  const sharedRefresh = cache.loadModelCatalog(settings());
  assert.equal(completions.length, 2);
  completions[1](catalog('a', ['new']));
  await Promise.all([afterLogin, sharedRefresh]);
  assert.deepEqual(cache.cachedModelCatalog(settings()).reasoning.options.map(option => option.id), ['new']);
});
