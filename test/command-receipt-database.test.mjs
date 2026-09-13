import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationDatabase } from '../src/runtime/database.mjs';
import { CommandReceiptStore } from '../src/runtime/command-receipts.mjs';
import { CommandReceiptDatabaseFacade, committedTurnDelivery } from '../src/runtime/command-receipt-database.mjs';

test('direct turn creation and command acceptance commit atomically', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-command-db-'));
  const db = new ConversationDatabase(join(dir, 'conversations.sqlite3'));
  try {
    db.createSession({ id: 's1', projectId: null, now: 1 });
    const receipts = new CommandReceiptStore(db.sqlRepository());
    receipts.begin({ commandId: 'cmd-1', method: 'session.send', sessionId: 's1', params: sendParams(), now: 2 });
    const facade = new CommandReceiptDatabaseFacade(db, receipts);

    facade.run({ commandId: 'cmd-1', method: 'session.send', sourceSessionId: 's1' }, () => {
      facade.database.transaction(() => {
        const user = facade.database.appendMessage({ id: 'u1', sessionId: 's1', role: 'user', content: 'hello', now: 3 });
        const assistant = facade.database.appendMessage({ id: 'a1', sessionId: 's1', role: 'assistant', content: '', status: 'streaming', now: 4 });
        return { user, assistant, targetSession: facade.database.getSessionSummary('s1') };
      });
    });

    const receipt = receipts.get('cmd-1');
    assert.equal(receipt.state, 'accepted');
    assert.deepEqual(receipt.result, {
      accepted: true,
      sessionId: 's1',
      sourceSessionId: 's1',
      messageId: 'a1',
      projectId: null,
      committed: true,
    });
    assert.equal(db.getMessage('a1')?.status, 'streaming');
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('receipt acceptance rolls back with the turn transaction', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-command-db-rollback-'));
  const db = new ConversationDatabase(join(dir, 'conversations.sqlite3'));
  try {
    db.createSession({ id: 's1', now: 1 });
    const receipts = new CommandReceiptStore(db.sqlRepository());
    receipts.begin({ commandId: 'cmd-rb', method: 'session.send', sessionId: 's1', params: sendParams(), now: 2 });
    const facade = new CommandReceiptDatabaseFacade(db, receipts);

    assert.throws(() => facade.run({ commandId: 'cmd-rb', method: 'session.send', sourceSessionId: 's1' }, () => {
      facade.database.transaction(() => {
        const user = facade.database.appendMessage({ id: 'u-rb', sessionId: 's1', role: 'user', content: 'hello', now: 3 });
        const assistant = facade.database.appendMessage({ id: 'a-rb', sessionId: 's1', role: 'assistant', content: '', status: 'streaming', now: 4 });
        const delivery = { user, assistant, targetSession: facade.database.getSessionSummary('s1') };
        assert.ok(committedTurnDelivery(delivery));
        throw new Error('abort transaction');
      });
    }), /abort transaction/);

    assert.equal(db.getMessage('u-rb'), null);
    assert.equal(db.getMessage('a-rb'), null);
    assert.equal(receipts.get('cmd-rb')?.state, 'processing');
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('facade ignores unrelated transactions and accepts only a user+streaming-assistant delivery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-command-db-filter-'));
  const db = new ConversationDatabase(join(dir, 'conversations.sqlite3'));
  try {
    db.createSession({ id: 's1', now: 1 });
    const receipts = new CommandReceiptStore(db.sqlRepository());
    receipts.begin({ commandId: 'cmd-filter', method: 'session.send', sessionId: 's1', params: sendParams(), now: 2 });
    const facade = new CommandReceiptDatabaseFacade(db, receipts);

    facade.run({ commandId: 'cmd-filter', method: 'session.send', sourceSessionId: 's1' }, () => {
      facade.database.transaction(() => facade.database.renameSession('s1', 'renamed', 3));
    });

    assert.equal(receipts.get('cmd-filter')?.state, 'processing');
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function sendParams() {
  return {
    sessionId: 's1',
    text: 'hello',
    attachments: [],
    provider: {
      providerID: 'openai',
      primary: { providerID: 'openai', modelID: 'gpt-test', variant: '' },
      secondary: { providerID: 'openai', modelID: 'gpt-small', variant: '' },
    },
  };
}
