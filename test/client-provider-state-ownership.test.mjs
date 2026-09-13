import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../src/renderer/react/App.tsx', import.meta.url), 'utf8');
const providerState = await readFile(new URL('../src/renderer/react/client-provider-state.ts', import.meta.url), 'utf8');

test('App consumes shared provider settings without owning a provider snapshot', () => {
  assert.match(app, /const provider = useClientProviderSettings\(\)/);
  assert.match(app, /refreshClientProviderSettings\(\)/);
  assert.match(app, /onSaved=\{hydrateClientProviderSettings\}/);
  assert.doesNotMatch(app, /useState<ProviderSettings/);
  assert.doesNotMatch(app, /setProvider\(/);
  assert.doesNotMatch(app, /window\.cuppet\.settings\.get\(\)/);
});

test('client provider store owns settings refresh and provider-change synchronization', () => {
  assert.match(providerState, /useSyncExternalStore/);
  assert.match(providerState, /window\.cuppet\.settings\.get\(\)/);
  assert.match(providerState, /PROVIDER_SETTINGS_EVENT/);
  assert.match(providerState, /window\.addEventListener\(PROVIDER_SETTINGS_EVENT/);
  assert.match(providerState, /window\.removeEventListener\(PROVIDER_SETTINGS_EVENT/);
  assert.match(providerState, /if \(refreshPromise\) return refreshPromise/);
  assert.match(providerState, /hydrateClientProviderSettings\(next\)/);
});
