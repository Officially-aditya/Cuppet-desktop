import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const app = await readFile(new URL('../src/renderer/react/App.tsx', import.meta.url), 'utf8');
const clientRunState = await readFile(new URL('../src/renderer/react/client-run-state.ts', import.meta.url), 'utf8');

async function loadRunState() {
  const source = stripTypeScriptTypes(clientRunState).replace(/import \{ useSyncExternalStore \} from 'react';/, '');
  return import(`data:text/javascript,${encodeURIComponent(source)}`);
}

test('run-state membership includes only active sessions throughout their lifecycle', async () => {
  const store = await loadRunState();
  store.resetClientRunStateStore();
  store.hydrateClientRunState([
    { id: 'idle', lastStatus: 'complete', messages: [] },
    { id: 'active', lastStatus: 'streaming', messages: [] },
  ]);
  assert.equal(store.clientRunStateSnapshot().has('idle'), false);
  assert.equal(store.clientRunStateSnapshot().has('active'), true);
  store.reduceClientRunEvent({ type: 'run.finished', sessionId: 'active', status: 'complete' });
  assert.equal(store.clientRunStateSnapshot().has('active'), false);
  store.markClientRunStarted('idle');
  assert.equal(store.clientRunStateSnapshot().has('idle'), true);
  store.reduceClientRunEvent({ type: 'pe3.routed', sourceSessionId: 'idle', targetSessionId: 'target' });
  assert.equal(store.clientRunStateSnapshot().has('idle'), false);
  assert.equal(store.clientRunStateSnapshot().has('target'), true);
  store.resetClientRunStateStore();
});

test('App consumes shared run state without owning a mutable running-session projection', () => {
  assert.match(app, /const running = useClientRunState\(\)/);
  assert.match(app, /hydrateClientRunState\(nextSessions\)/);
  assert.match(app, /hydrateClientRunSession\(session\)/);
  assert.match(app, /markClientRunStarted\(target\)/);
  assert.doesNotMatch(app, /useState<Set<string>>/);
  assert.doesNotMatch(app, /setRunning\(/);
  assert.doesNotMatch(app, /event\.type === 'run\.started'/);
});

test('client run-state store owns runtime lifecycle reduction and one external subscription', () => {
  assert.match(clientRunState, /useSyncExternalStore/);
  assert.match(clientRunState, /window\.cuppet\.onEvent/);
  assert.match(clientRunState, /type === 'run\.started'/);
  assert.match(clientRunState, /type === 'run\.finished'/);
  assert.match(clientRunState, /type === 'pe3\.routed'/);
  assert.match(clientRunState, /session\.lastStatus === 'streaming'/);
  assert.match(clientRunState, /message\.status === 'streaming'/);
  assert.match(clientRunState, /if \(!listeners\.size\) releaseRuntimeSubscription\(\)/);
});
