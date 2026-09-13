import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const modal = await readFile(new URL('../src/renderer/react/RemoteModal.tsx', import.meta.url), 'utf8');
const remoteState = await readFile(new URL('../src/renderer/react/client-remote-state.ts', import.meta.url), 'utf8');

test('RemoteModal consumes shared remote connection status while keeping pairing UI local', () => {
  assert.match(modal, /const status = useClientRemoteStatus\(\)/);
  assert.match(modal, /refreshClientRemoteStatus\(\)/);
  assert.match(modal, /hydrateClientRemoteStatus\(result\.status\)/);
  assert.doesNotMatch(modal, /useState<RemoteStatus>/);
  assert.doesNotMatch(modal, /setStatus\(/);
  assert.doesNotMatch(modal, /window\.cuppet\.remote\.status\(\)/);
  assert.doesNotMatch(modal, /event\?\.type === 'remote\.started'/);
  assert.doesNotMatch(modal, /event\?\.type === 'remote\.stopped'/);
  assert.doesNotMatch(modal, /event\?\.type === 'remote\.device'/);

  assert.match(modal, /useState<RemoteInvite \| null>/);
  assert.match(modal, /useState\(''\)/);
  assert.match(modal, /event\?\.type === 'remote\.setup'/);
  assert.match(modal, /event\?\.type === 'remote\.invite'/);
});

test('client remote store owns status refresh and remote lifecycle projection', () => {
  assert.match(remoteState, /useSyncExternalStore/);
  assert.match(remoteState, /window\.cuppet\.remote\.status\(\)/);
  assert.match(remoteState, /window\.cuppet\.onEvent/);
  assert.match(remoteState, /if \(refreshPromise\) return refreshPromise/);
  assert.match(remoteState, /type === 'remote\.started'/);
  assert.match(remoteState, /type === 'remote\.setup'/);
  assert.match(remoteState, /type === 'remote\.device'/);
  assert.match(remoteState, /type === 'remote\.stopped'/);
  assert.match(remoteState, /type === 'remote\.revoked'/);
  assert.match(remoteState, /if \(!listeners\.size\) releaseRuntimeSubscription\(\)/);
});
