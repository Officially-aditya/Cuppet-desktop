import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../src/renderer/react/App.tsx', import.meta.url), 'utf8');
const sessionState = await readFile(new URL('../src/renderer/react/client-session-state.ts', import.meta.url), 'utf8');

test('App consumes shared session collection without owning a mutable session list', () => {
  assert.match(app, /const sessions = useClientSessions\(\)/);
  assert.match(app, /refreshClientSessions\(\)/);
  assert.match(app, /upsertClientSession\(session\)/);
  assert.doesNotMatch(app, /useState<Session\[\]>/);
  assert.doesNotMatch(app, /setSessions\(/);
  assert.doesNotMatch(app, /window\.cuppet\.sessions\.list\(\)/);
  assert.doesNotMatch(app, /if \(event\.session\) setSessions/);
  assert.doesNotMatch(app, /function upsertSession\(/);
});

test('client session store owns list refresh, event upserts, and lifecycle reconciliation', () => {
  assert.match(sessionState, /useSyncExternalStore/);
  assert.match(sessionState, /window\.cuppet\.sessions\.list\(\)/);
  assert.match(sessionState, /window\.cuppet\.onEvent/);
  assert.match(sessionState, /event\?\.session\?\.id/);
  assert.match(sessionState, /upsertClientSession\(event\.session\)/);
  assert.match(sessionState, /SESSION_COLLECTION_REFRESH_EVENTS/);
  assert.match(sessionState, /'session\.archived'/);
  assert.match(sessionState, /'session\.deleted'/);
  assert.match(sessionState, /'session\.restored'/);
  assert.match(sessionState, /'session\.purged'/);
  assert.match(sessionState, /if \(refreshPromise\) return refreshPromise/);
  assert.match(sessionState, /if \(!listeners\.size\) releaseRuntimeSubscription\(\)/);
});
