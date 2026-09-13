import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [app, chat, clientTranscript, transcript, runtimeMain] = await Promise.all([
  readFile(new URL('../src/renderer/react/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/renderer/react/ChatPane.tsx', import.meta.url), 'utf8'),
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
  assert.match(app, /window\.cuppet\.sessions\.send/);
  assert.doesNotMatch(app, /queue\.queued|queue\.dispatched|setActivities\(|reduceActivity\(/);

  assert.match(runtimeMain, /case 'session\.send': \{/);
  assert.match(runtimeMain, /new SessionCommandSerializer\(\)/);
  assert.match(runtimeMain, /sendCommands\.run\(sessionId, \(\) => sendOrQueue\(params, context\.commandId\)\)/);
  assert.match(runtimeMain, /new CommandReceiptStore\(repository\)/);
  assert.match(runtimeMain, /turnStore\.enqueue\(/);
  assert.match(runtimeMain, /queueSafeSendParams\(/);
  assert.match(runtimeMain, /drainQueued\(/);
  assert.match(runtimeMain, /turnStore\.queuedSessions\(\)/);
});

test('React transcript consumes canonical runtime events through the client transcript store', () => {
  // App may refresh the durable session snapshot at tool boundaries, but it no longer
  // owns a parallel activity/validation/queue trace projection.
  assert.match(app, /tool\.started/);
  assert.match(app, /tool\.finished/);
  assert.doesNotMatch(app, /validation\.completed|setActivities\(|hydrateToolActivity\(|reduceActivity\(/);

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
