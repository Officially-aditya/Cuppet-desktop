import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [app, chat, clientSessionState, clientTranscript, transcript, runtimeMain] = await Promise.all([
  readFile(new URL('../src/renderer/react/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/renderer/react/ChatPane.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/renderer/react/client-session-state.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/renderer/react/client-transcript.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/renderer/react/chat-transcript.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/runtime/main.mjs', import.meta.url), 'utf8'),
]);

test('React composer selects queue or steer intent while durable queue ownership stays in runtime', () => {
  assert.match(chat, /export type DeliveryMode = 'queue' \| 'steer'/);
  assert.match(chat, /readSendBehavior\(\)/);
  assert.match(chat, /onSend\(raw, deliveryMode, attachments\)/);
  assert.doesNotMatch(chat, /queuedBySession|queueDispatching|deliveryMode === 'queue'/);

  assert.match(app, /deliveryMode === 'steer'/);
  assert.match(app, /cuppet\.steer\.interrupt/);
  assert.doesNotMatch(app, /setActivities\(|reduceActivity\(/);

  assert.match(runtimeMain, /case 'session\.send': \{/);
  assert.match(runtimeMain, /new SessionCommandSerializer\(\)/);
  assert.match(runtimeMain, /sendCommands\.run\(sessionId, \(\) => sendOrQueue\(params, context\.commandId\)\)/);
  assert.match(runtimeMain, /new CommandReceiptStore\(repository\)/);
  assert.match(runtimeMain, /turnStore\.enqueue\(/);
  assert.match(runtimeMain, /queueSafeSendParams\(/);
  assert.match(runtimeMain, /drainQueued\(/);
  assert.match(runtimeMain, /turnStore\.queuedSessions\(\)/);
});

test('React transcript consumes canonical runtime events through client projections', () => {
  // App owns navigation and dispatch only. Durable session detail refreshes at tool/run
  // boundaries belong to the shared session projection, while live Activity reduction
  // belongs to the shared transcript projection.
  assert.doesNotMatch(app, /tool\.started|tool\.finished|validation\.completed|setActivities\(|hydrateToolActivity\(|reduceActivity\(/);

  assert.match(clientSessionState, /SESSION_DETAIL_REFRESH_EVENTS/);
  assert.match(clientSessionState, /'tool\.started'/);
  assert.match(clientSessionState, /'tool\.finished'/);
  assert.match(clientSessionState, /'run\.finished'/);
  assert.match(clientSessionState, /refreshClientSession\(sessionId\)/);

  assert.match(chat, /useClientTranscript\(session\)/);
  assert.doesNotMatch(chat, /runtime\.activity/);
  assert.doesNotMatch(chat, /reduceTranscriptEvent/);
  assert.doesNotMatch(chat, /hydrateTranscript/);
  assert.doesNotMatch(chat, /window\.cuppet\.onEvent/);
  assert.doesNotMatch(chat, /activity\.reasoning\.delta/);
  assert.doesNotMatch(chat, /activity\.tool\./);
  assert.doesNotMatch(chat, /traceByMessage|updateToolTraceFromActivity/);

  assert.match(clientTranscript, /window\.cuppet\.onEvent/);
  assert.match(clientTranscript, /runtime\.activity/);
  assert.match(clientTranscript, /reduceTranscriptEvent/);
  assert.match(clientTranscript, /hydrateTranscript/);

  assert.match(transcript, /event\.source === 'provider' && activityType === 'activity\.reasoning\.delta'/);
  assert.match(transcript, /event\.source === 'execution' && activityType\.startsWith\('activity\.tool\.'\)/);
  assert.match(transcript, /event\.type !== 'runtime\.activity'/);
  assert.match(transcript, /hydrateTranscript/);
});
