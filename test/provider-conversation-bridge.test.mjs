import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationBridge, fingerprintConversationMessages } from '../src/runtime/providers/conversation-bridge.mjs';
import { ProviderRuntimeManager } from '../src/runtime/providers/runtime-manager.mjs';

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
  assert.equal(snapshot.totalCompletedTurns, 2);
  assert.equal(snapshot.warmRuntimeCount, 1);
  assert.equal(snapshot.contextOwner, 'cuppet');
  assert.equal(snapshot.providerHistory, 'turn-isolated');
  assert.equal(snapshot.lastReplayFingerprint, second.replayFingerprint);
});

test('Conversation Bridge rejects concurrent turns while preserving state for warm runtime switching', () => {
  const bridge = new ConversationBridge();
  const first = bridge.beginTurn({ conversationId: 'chat-1', runtimeFingerprint: 'runtime-a', messages: [] });
  assert.throws(
    () => bridge.beginTurn({ conversationId: 'chat-1', runtimeFingerprint: 'runtime-b', messages: [] }),
    /already has an active provider bridge turn/,
  );
  bridge.completeTurn(first);

  const changed = bridge.beginTurn({ conversationId: 'chat-1', runtimeFingerprint: 'runtime-b', messages: [] });
  assert.equal(changed.providerSessionAction, 'start');
  bridge.completeTurn(changed);
  assert.equal(bridge.snapshot('chat-1').runtimeFingerprint, 'runtime-b');
  assert.equal(bridge.snapshot('chat-1').warmRuntimeCount, 2);

  const returned = bridge.beginTurn({ conversationId: 'chat-1', runtimeFingerprint: 'runtime-a', messages: [] });
  assert.equal(returned.providerSessionAction, 'new-session');
  bridge.completeTurn(returned);
  const snapshot = bridge.snapshot('chat-1');
  assert.equal(snapshot.runtimeFingerprint, 'runtime-a');
  assert.equal(snapshot.completedTurns, 2);
  assert.equal(snapshot.totalCompletedTurns, 3);
});

test('failed or cancelled bridge turns discard only ambiguous provider-side route state', () => {
  const bridge = new ConversationBridge();
  const first = bridge.beginTurn({ conversationId: 'chat-fail', runtimeFingerprint: 'runtime-a', messages: [{ role: 'user', content: 'work' }] });
  assert.equal(bridge.abortTurn(first), true);
  assert.equal(bridge.snapshot('chat-fail').completedTurns, 0);

  const retry = bridge.beginTurn({ conversationId: 'chat-fail', runtimeFingerprint: 'runtime-a', messages: [{ role: 'user', content: 'work' }] });
  assert.equal(retry.providerSessionAction, 'start');
  bridge.completeTurn(retry);

  const other = bridge.beginTurn({ conversationId: 'chat-fail', runtimeFingerprint: 'runtime-b', messages: [] });
  bridge.completeTurn(other);
  const failedOther = bridge.beginTurn({ conversationId: 'chat-fail', runtimeFingerprint: 'runtime-b', messages: [] });
  assert.equal(bridge.abortTurn(failedOther), true);

  const safeRoute = bridge.beginTurn({ conversationId: 'chat-fail', runtimeFingerprint: 'runtime-a', messages: [] });
  assert.equal(safeRoute.providerSessionAction, 'new-session');
});

test('forgotten or evicted bridge runtime state can never request logical-session reuse', () => {
  const bridge = new ConversationBridge();
  const first = bridge.beginTurn({ conversationId: 'chat-evict', runtimeFingerprint: 'runtime-a', messages: [] });
  bridge.completeTurn(first);
  assert.equal(bridge.forgetRuntime('chat-evict', 'runtime-a'), true);

  const afterEviction = bridge.beginTurn({ conversationId: 'chat-evict', runtimeFingerprint: 'runtime-a', messages: [] });
  assert.equal(afterEviction.providerSessionAction, 'start');
  bridge.completeTurn(afterEviction);
  assert.equal(bridge.forget('chat-evict'), true);
});

test('runtime manager follows bridge plans while replaying full Cuppet context each turn', async () => {
  const calls = [];
  const runtime = {
    async start() { calls.push('start'); },
    async newSession() { calls.push('newSession'); },
    async runTurn({ messages }) { calls.push(['messages', messages.map((item) => item.content)]); return { text: 'ok', usage: null }; },
    async cancel() {},
    async close() { calls.push('close'); },
  };
  const manager = new ProviderRuntimeManager({ usageRecorder: async () => {}, acpRuntimeFactory: () => runtime });
  const adapter = managedAdapter();
  try {
    await manager.adapterFor({ sessionId: 'chat-context', adapter }).stream([{ role: 'user', content: 'one' }]);
    await manager.adapterFor({ sessionId: 'chat-context', adapter }).stream([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'two' },
    ]);
    assert.deepEqual(calls.slice(0, 4), [
      'start',
      ['messages', ['one']],
      'newSession',
      ['messages', ['one', 'answer', 'two']],
    ]);
    const snapshot = manager.conversationSnapshot('chat-context');
    assert.equal(snapshot.completedTurns, 2);
    assert.equal(snapshot.totalCompletedTurns, 2);
    assert.equal(snapshot.warmRuntimeCount, 1);
    assert.equal(snapshot.contextOwner, 'cuppet');
    assert.equal(snapshot.delivery, 'full-replay');
    assert.equal(snapshot.providerHistory, 'turn-isolated');
  } finally {
    await manager.close();
  }
});

test('runtime failure and idle eviction reset the affected Conversation Bridge route', async () => {
  let fail = true;
  const runtimes = [];
  const manager = new ProviderRuntimeManager({
    idleMs: 15,
    usageRecorder: async () => {},
    acpRuntimeFactory: () => {
      const runtime = {
        async start() {},
        async newSession() {},
        async runTurn() { if (fail) throw new Error('provider failed'); return { text: 'ok', usage: null }; },
        async cancel() {},
        async close() {},
      };
      runtimes.push(runtime);
      return runtime;
    },
  });
  const adapter = managedAdapter();
  await assert.rejects(() => manager.adapterFor({ sessionId: 'chat-reset', adapter }).stream([]), /provider failed/);
  assert.equal(manager.conversationSnapshot('chat-reset').completedTurns, 0);

  fail = false;
  await manager.adapterFor({ sessionId: 'chat-reset', adapter }).stream([]);
  assert.equal(manager.conversationSnapshot('chat-reset').completedTurns, 1);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(manager.size, 0);
  assert.equal(manager.conversationSnapshot('chat-reset').completedTurns, 0);
  assert.ok(runtimes.length >= 2);
  await manager.close();
});

function managedAdapter() {
  return {
    cuppetManagedRuntime: () => ({
      protocol: 'acp',
      backendId: 'opencode',
      descriptor: { id: 'opencode', label: 'OpenCode', transport: 'acp', command: 'opencode', args: [], envOverride: '', loginHint: '' },
      configuration: { providerID: 'opencode' },
    }),
  };
}
