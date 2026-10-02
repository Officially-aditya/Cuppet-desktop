import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source = stripTypeScriptTypes(await readFile(new URL('../src/renderer/react/model-pins.ts', import.meta.url), 'utf8'))
  .replace(/import \{ useSyncExternalStore \} from 'react';/, '');
let instance = 0;
const load = () => import(`data:text/javascript,${encodeURIComponent(source + '\n// instance ' + instance++)}`);

async function fixture(t, initial = null) {
  const previous = globalThis.localStorage;
  let saved = initial;
  globalThis.localStorage = { getItem: () => saved, setItem: (_key, value) => { saved = value; } };
  t.after(() => {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  });
  return { pins: await load(), saved: () => saved };
}

test('pins are saved per provider, survive reload, and can be removed', async (t) => {
  const { pins, saved } = await fixture(t);
  pins.togglePinnedModel('first', 'alpha');
  const before = pins.modelPinsSnapshot();
  pins.togglePinnedModel('first', 'beta');
  pins.togglePinnedModel('second', 'gamma');
  assert.deepEqual(before.first, ['alpha']);
  assert.deepEqual(pins.modelPinsSnapshot(), { first: ['alpha', 'beta'], second: ['gamma'] });
  assert.deepEqual(JSON.parse(saved()), pins.modelPinsSnapshot());
  const reloaded = await load();
  assert.deepEqual(reloaded.modelPinsSnapshot(), pins.modelPinsSnapshot());
  reloaded.togglePinnedModel('first', 'alpha');
  assert.deepEqual(reloaded.modelPinsSnapshot().first, ['beta']);
  assert.deepEqual(reloaded.modelPinsSnapshot().second, ['gamma']);
});

test('pinned models sort first in pinning order while other models retain provider order', async (t) => {
  const { pins } = await fixture(t);
  const models = [{ id: 'alpha' }, { id: 'beta' }, { id: 'gamma' }, { id: 'delta' }];
  assert.deepEqual(pins.orderPinnedModels(models, ['gamma', 'beta']).map((model) => model.id), ['gamma', 'beta', 'alpha', 'delta']);
  assert.deepEqual(models.map((model) => model.id), ['alpha', 'beta', 'gamma', 'delta']);
  assert.deepEqual(pins.orderPinnedModels(models, []), models);
});

test('pins never introduce models absent from the available model list', async (t) => {
  const { pins } = await fixture(t);
  const models = [{ id: 'alpha' }, { id: 'beta' }];
  assert.deepEqual(pins.orderPinnedModels(models, ['missing', 'beta']).map((model) => model.id), ['beta', 'alpha']);
});

test('saved pins ignore invalid entries and duplicate model IDs', async (t) => {
  const { pins } = await fixture(t, JSON.stringify({ first: ['alpha', 'alpha', null, 7, ''], invalid: 'not a list' }));
  assert.deepEqual(pins.modelPinsSnapshot(), { first: ['alpha'] });
  pins.togglePinnedModel('', 'beta');
  pins.togglePinnedModel('first', '');
  assert.deepEqual(pins.modelPinsSnapshot(), { first: ['alpha'] });
});
