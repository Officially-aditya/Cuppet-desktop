import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/runtime/main.mjs', import.meta.url), 'utf8');
const desktopMain = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8');
const runtimeClient = await readFile(new URL('../src/main/runtime-client.mjs', import.meta.url), 'utf8');
const chatPane = await readFile(new URL('../src/renderer/react/ChatPane.tsx', import.meta.url), 'utf8');

test('runtime host serializes queued turns through the shared durable turn store', () => {
  assert.match(source, /case 'session\.send': return sendOrQueue\(params, context\.commandId\)/);
  assert.match(source, /const localState = new ConversationDatabase\(databasePath\)/);
  assert.match(source, /const repository = localState\.sqlRepository\(\)/);
  assert.match(source, /new TurnStore\(repository, \{ legacyPath: join\(dataDir, 'turn-state\.sqlite3'\) \}\)/);
  assert.doesNotMatch(source, /new TurnStore\(join\(dataDir, 'turn-state\.sqlite3'\)\)/, 'legacy turn-state.sqlite3 must not remain a live runtime authority');
  assert.match(source, /turnStore\.enqueue\(/);
  assert.match(source, /turnStore\.claimNext\(/);
  assert.match(source, /turnStore\.completeQueue\(/);
  assert.match(source, /turnStore\.failQueue\(/);
  assert.match(source, /type: 'queue\.queued'/);
  assert.match(source, /type: 'queue\.started'/);
  assert.match(source, /type: 'queue\.dispatched'/);
  assert.match(source, /type: 'queue\.failed'/);
});

test('durable runs are the only active-session authority in the runtime host', () => {
  assert.match(source, /new RunStateProjection\(repository\)/);
  assert.match(source, /runState\.isActive\(sessionId\)/);
  assert.match(source, /runState\.isActive\(ownerSessionId\)/);
  assert.match(source, /runState\.isActive\(runSessionId\)/);
  assert.doesNotMatch(source, /activeSessions/, 'runtime main must not keep an in-memory active-session mirror of durable runs');
});

test('rerouted queue continuation is derived from durable run source identity', () => {
  assert.match(source, /const durableRun = turnStore\.getRun\(event\.messageId\)/);
  assert.match(source, /queueOwnerSessionId = durableRun\?\.sourceSessionId \?\? durableRun\?\.sessionId \?\? event\.sessionId/);
  assert.match(source, /drainQueued\(queueOwnerSessionId\)/);
  assert.doesNotMatch(source, /queueOwnerByRun/, 'queue ownership must survive restart through runs.source_session_id rather than an in-memory map');
});

test('session.send uses durable command receipts and secret-free queue persistence', () => {
  assert.match(source, /new CommandReceiptStore\(repository\)/);
  assert.match(source, /commandReceipts\.resolve\(\{ commandId: receiptId, method: 'session\.send', params \}\)/);
  assert.match(source, /commandReceipts\.begin\(/);
  assert.match(source, /commandReceipts\.accept\(/);
  assert.match(source, /commandReceipts\.fail\(/);
  assert.match(source, /params: queueSafeSendParams\(\{ \.\.\.params, sessionId \}\)/);
  assert.match(source, /rehydrateQueuedSendParams\(item\.params, currentProviderConfig\)/);
  assert.match(source, /!currentProviderConfig/);
  assert.doesNotMatch(source, /params: \{ \.\.\.params, sessionId \}/, 'raw provider credentials must never be persisted in queued_turns');
});

test('queued turns resume only after host provider config is synchronized', () => {
  assert.match(source, /case 'provider\.config\.sync': return syncProviderConfig\(params\.provider\)/);
  assert.match(source, /for \(const sessionId of turnStore\.queuedSessions\(\)\) queueMicrotask\(\(\) => void drainQueued\(sessionId\)\)/);
  assert.doesNotMatch(source, /write\(\{ kind: 'event', event: \{ type: 'runtime\.ready',[\s\S]*?for \(const sessionId of turnStore\.queuedSessions\(\)/, 'runtime startup must not drain durable queues before host secrets are re-synced');
  assert.match(desktopMain, /runtime\.request\('provider\.config\.sync'/);
  assert.match(desktopMain, /runtime\.on\('recovered',[\s\S]*?syncProviderConfig/);
});

test('RuntimeClient reuses one request id for durable sends and preserves receipt error codes', () => {
  assert.match(runtimeClient, /const DURABLE_COMMAND_METHODS = new Set\(\['session\.send'\]\)/);
  assert.match(runtimeClient, /return this\.#rawRequest\(method, params, timeoutMs, requestId\)/);
  assert.match(runtimeClient, /typeof message\.code === 'string' \? message\.code : 'CUPPET_RUNTIME_REQUEST_FAILED'/);
});

test('renderer delegates queue ownership to the runtime', () => {
  assert.doesNotMatch(chatPane, /queuedBySession/);
  assert.doesNotMatch(chatPane, /queueDispatching/);
  assert.doesNotMatch(chatPane, /type QueuedMessage/);
  assert.match(chatPane, /The runtime owns queueing/);
});

test('remote manager calls through the same runtime host boundary and preserves durable command context', () => {
  assert.match(source, /new RemoteManager\(\{ dataDir, call: \(method, params, context\) => handle\(method, params, context\)/);
});
