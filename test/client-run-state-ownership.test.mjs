import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../src/renderer/react/App.tsx', import.meta.url), 'utf8');
const clientRunState = await readFile(new URL('../src/renderer/react/client-run-state.ts', import.meta.url), 'utf8');

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
