import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationDatabase } from '../src/runtime/database.mjs';
import { CommandReceiptStore, commandFingerprint, commandReceiptResult } from '../src/runtime/command-receipts.mjs';

test('accepted session.send command ids replay the original acceptance without a second dispatch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-command-receipt-'));
  const db = new ConversationDatabase(join(dir, 'conversations.sqlite3'));
  try {
    const store = new CommandReceiptStore(db.sqlRepository());
    const params = sendParams('sk-first');
    const begun = store.begin({ commandId: 'cmd-1', method: 'session.send', sessionId: 's1', params, now: 10 });
    assert.equal(begun.created, true);
    const accepted = store.accept('cmd-1', { accepted: true, sessionId: 's1', messageId: 'm1' }, 20);
    assert.equal(accepted.state, 'accepted');

    const replay = store.resolve({ commandId: 'cmd-1', method: 'session.send', params: sendParams('sk-rotated') });
    assert.deepEqual(replay, { replay: true, result: { accepted: true, sessionId: 's1', messageId: 'm1' } });
    assert.deepEqual(commandReceiptResult(store.get('cmd-1')), replay.result);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('processing commands become unknown after restart and are never replayable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-command-restart-'));
  const path = join(dir, 'conversations.sqlite3');
  let db = new ConversationDatabase(path);
  try {
    let store = new CommandReceiptStore(db.sqlRepository(), () => 10);
    store.begin({ commandId: 'cmd-crash', method: 'session.send', sessionId: 's1', params: sendParams('sk-secret'), now: 11 });
    assert.equal(store.get('cmd-crash').state, 'processing');
    db.close();

    db = new ConversationDatabase(path);
    store = new CommandReceiptStore(db.sqlRepository(), () => 30);
    const receipt = store.get('cmd-crash');
    assert.equal(receipt.state, 'unknown');
    assert.match(receipt.error, /not replayed/i);
    assert.throws(
      () => store.resolve({ commandId: 'cmd-crash', method: 'session.send', params: sendParams('sk-secret') }),
      (error) => error?.code === 'COMMAND_OUTCOME_UNKNOWN',
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('command id reuse with a different logical request is rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-command-conflict-'));
  const db = new ConversationDatabase(join(dir, 'conversations.sqlite3'));
  try {
    const store = new CommandReceiptStore(db.sqlRepository());
    store.begin({ commandId: 'cmd-same', method: 'session.send', sessionId: 's1', params: sendParams('sk-a') });
    assert.throws(
      () => store.resolve({ commandId: 'cmd-same', method: 'session.send', params: { ...sendParams('sk-b'), text: 'different' } }),
      (error) => error?.code === 'COMMAND_RECEIPT_CONFLICT',
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('session.send fingerprint ignores credential rotation but keeps provider/model identity', () => {
  const first = commandFingerprint('session.send', sendParams('sk-one'));
  const rotated = commandFingerprint('session.send', sendParams('sk-two'));
  const changedModel = commandFingerprint('session.send', {
    ...sendParams('sk-two'),
    provider: { ...sendParams('sk-two').provider, primary: { providerID: 'openai', modelID: 'gpt-next' } },
  });
  assert.equal(first, rotated);
  assert.notEqual(first, changedModel);
});

function sendParams(apiKey) {
  return {
    sessionId: 's1',
    text: 'do exactly once',
    attachments: [],
    provider: {
      providerID: 'openai',
      baseUrl: 'https://api.example.test/v1',
      apiKey,
      primary: { providerID: 'openai', modelID: 'gpt-test', variant: 'high' },
      secondary: { providerID: 'openai', modelID: 'gpt-small', variant: '' },
    },
  };
}
