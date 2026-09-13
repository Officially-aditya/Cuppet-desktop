import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [app, chat, transcript, runtimeMain] = await Promise.all([
  readFile(new URL('../src/renderer/react/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/renderer/react/ChatPane.tsx', import.meta.url), 'utf8'),
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
  assert.match(app, /queue\.queued/);
  assert.match(app, /queue\.dispatched/);

  assert.match(runtimeMain, /case 'session\.send': return sendOrQueue\(params\)/);
  assert.match(runtimeMain, /turnStore\.enqueue\(/);
  assert.match(runtimeMain, /drainQueued\(/);
  assert.match(runtimeMain, /turnStore\.queuedSessions\(\)/);
});

test('React transcript consumes canonical runtime events through one transcript reducer', () => {
  assert.match(app, /tool\.started/);
  assert.match(app, /tool\.finished/);
  assert.match(app, /validation\.completed/);

  assert.match(chat, /runtime\.activity/);
  assert.match(chat, /reduceTranscriptEvent/);
  assert.match(chat, /hydrateTranscript/);
  assert.doesNotMatch(chat, /activity\.reasoning\.delta/);
  assert.doesNotMatch(chat, /activity\.tool\./);
  assert.doesNotMatch(chat, /traceByMessage|updateToolTraceFromActivity/);

  assert.match(transcript, /event\.source === 'provider' && activityType === 'activity\.reasoning\.delta'/);
  assert.match(transcript, /event\.source === 'execution' && activityType\.startsWith\('activity\.tool\.'\)/);
  assert.match(transcript, /event\.type !== 'runtime\.activity'/);
  assert.match(transcript, /hydrateTranscript/);
});
