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

test('App owns only active session selection while shared store owns active server projection', () => {
  assert.match(app, /const \[activeSessionId, setActiveSessionId\] = useState<string \| null>\(null\)/);
  assert.match(app, /const active = useMemo\(\(\) => activeSessionId \? sessions\.find/);
  assert.match(app, /refreshClientSession\(sessionId\)/);
  assert.doesNotMatch(app, /useState<Session \| null>/);
  assert.doesNotMatch(app, /setActive\(/);
  assert.doesNotMatch(app, /window\.cuppet\.sessions\.get\(/);
  assert.doesNotMatch(app, /event\.type === 'message\.delta'/);
  assert.doesNotMatch(app, /function upsertMessage\(/);
  assert.doesNotMatch(app, /refreshActive/);
});

test('client session store owns list refresh, event upserts, lifecycle reconciliation, and detailed active state', () => {
  assert.match(sessionState, /useSyncExternalStore/);
  assert.match(sessionState, /window\.cuppet\.sessions\.list\(\)/);
  assert.match(sessionState, /window\.cuppet\.sessions\.get\(id\)/);
  assert.match(sessionState, /window\.cuppet\.onEvent/);
  assert.match(sessionState, /event\?\.session\?\.id/);
  assert.match(sessionState, /upsertClientSession\(event\.session\)/);
  assert.match(sessionState, /upsertClientMessage\(event\.message\)/);
  assert.match(sessionState, /type === 'message\.delta'/);
  assert.match(sessionState, /SESSION_DETAIL_REFRESH_EVENTS/);
  assert.match(sessionState, /'run\.finished'/);
  assert.match(sessionState, /'tool\.started'/);
  assert.match(sessionState, /'tool\.finished'/);
  assert.match(sessionState, /SESSION_COLLECTION_REFRESH_EVENTS/);
  assert.match(sessionState, /'session\.archived'/);
  assert.match(sessionState, /'session\.deleted'/);
  assert.match(sessionState, /'session\.restored'/);
  assert.match(sessionState, /'session\.purged'/);
  assert.match(sessionState, /Object\.prototype\.hasOwnProperty\.call\(value, 'messages'\)/);
  assert.match(sessionState, /current\?\.messages \?\? \[\]/);
  assert.match(sessionState, /const previous = sessions;[\s\S]*return sessions !== previous/);
  assert.match(sessionState, /if \(refreshPromise\) return refreshPromise/);
  assert.match(sessionState, /detailRefreshes\.get\(id\)/);
  assert.match(sessionState, /if \(!listeners\.size\) releaseRuntimeSubscription\(\)/);
});
