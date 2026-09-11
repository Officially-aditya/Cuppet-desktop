import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationBridge, fingerprintConversationMessages } from '../src/runtime/providers/conversation-bridge.mjs';

test('Conversation Bridge makes Cuppet full replay the explicit context authority', () => {
  const bridge = new ConversationBridge();
  const messages = [{ role: 'user', content: 'one' }];
  const first = bridge.beginTurn({ conversationId: 'chat-1', runtimeFingerprint: 'runtime-a', messages });

  assert.equal(first.contextOwner, 'cuppet');
  assert.equal(first.delivery, 'full-replay');
  assert.equal(first.providerHistory, 'turn-isolated');
  assert.equal(first.providerSessionAction, 'start');
  assert.deepEqual(first.messages, messages);
  assert.equal(first.replayFingerprint, fingerprintConversationMessages(messages));

  // The bridge owns a replay snapshot rather than retaining the caller's array.
  messages[0].content = 'mutated outside bridge';
  assert.equal(first.messages[0].content, 'one');

  bridge.completeTurn(first);
  const secondMessages = [
    { role: 'user', content: 'one' },
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: 'two' },
  ];
  const second = bridge.beginTurn({ conversationId: 'chat-1', runtimeFingerprint: 'runtime-a', messages: secondMessages });
  assert.equal(second.providerSessionAction, 'new-session');
  assert.equal(second.replayFingerprint, fingerprintConversationMessages(secondMessages));
  bridge.completeTurn(second);

  const snapshot = bridge.snapshot('chat-1');
  assert.equal(snapshot.completedTurns, 2);
  assert.equal(snapshot.contextOwner, 'cuppet');
  assert.equal(snapshot.providerHistory, 'turn-isolated');
  assert.equal(snapshot.lastReplayFingerprint, second.replayFingerprint);
});

test('Conversation Bridge rejects concurrent turns and resets on runtime authority change', () => {
  const bridge = new ConversationBridge();
  const first = bridge.beginTurn({ conversationId: 'chat-1', runtimeFingerprint: 'runtime-a', messages: [] });
  assert.throws(
    () => bridge.beginTurn({ conversationId: 'chat-1', runtimeFingerprint: 'runtime-a', messages: [] }),
    /already has an active provider bridge turn/,
  );
  bridge.completeTurn(first);

  const changed = bridge.beginTurn({ conversationId: 'chat-1', runtimeFingerprint: 'runtime-b', messages: [] });
  assert.equal(changed.providerSessionAction, 'start');
  bridge.completeTurn(changed);
  assert.equal(bridge.snapshot('chat-1').runtimeFingerprint, 'runtime-b');
});

test('failed or cancelled bridge turns discard ambiguous provider-side history', () => {
  const bridge = new ConversationBridge();
  const first = bridge.beginTurn({ conversationId: 'chat-fail', runtimeFingerprint: 'runtime-a', messages: [{ role: 'user', content: 'work' }] });
  assert.equal(bridge.abortTurn(first), true);
  assert.equal(bridge.snapshot('chat-fail').completedTurns, 0);

  const retry = bridge.beginTurn({ conversationId: 'chat-fail', runtimeFingerprint: 'runtime-a', messages: [{ role: 'user', content: 'work' }] });
  assert.equal(retry.providerSessionAction, 'start');
});

test('forgotten or evicted bridge state can never request logical-session reuse', () => {
  const bridge = new ConversationBridge();
  const first = bridge.beginTurn({ conversationId: 'chat-evict', runtimeFingerprint: 'runtime-a', messages: [] });
  bridge.completeTurn(first);
  assert.equal(bridge.forget('chat-evict'), true);

  const afterEviction = bridge.beginTurn({ conversationId: 'chat-evict', runtimeFingerprint: 'runtime-a', messages: [] });
  assert.equal(afterEviction.providerSessionAction, 'start');
});
