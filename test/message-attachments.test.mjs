import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationDatabase } from '../src/runtime/database.mjs';

test('ConversationDatabase persists and hydrates message attachments including dataUrl', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-att-test-'));
  const dbPath = join(dir, 'conversations.sqlite3');
  const store = new ConversationDatabase(dbPath);

  try {
    const session = store.createSession({ id: 'sess_1', title: 'Image Test Chat' });
    assert.equal(session.id, 'sess_1');

    const sampleAttachments = [
      {
        name: 'screenshot.png',
        mime: 'image/png',
        size: 1024,
        dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      },
      {
        name: 'notes.txt',
        mime: 'text/plain',
        size: 42,
      },
    ];

    const userMsg = store.appendMessage({
      id: 'msg_user_1',
      sessionId: 'sess_1',
      role: 'user',
      content: 'Look at this screenshot',
      attachments: sampleAttachments,
    });

    assert.equal(userMsg.id, 'msg_user_1');
    assert.equal(Array.isArray(userMsg.attachments), true);
    assert.equal(userMsg.attachments.length, 2);
    assert.equal(userMsg.attachments[0].name, 'screenshot.png');
    assert.equal(userMsg.attachments[0].dataUrl, sampleAttachments[0].dataUrl);
    assert.equal(userMsg.attachments[1].name, 'notes.txt');
    assert.equal(userMsg.attachments[1].dataUrl, undefined);

    // Retrieve message individually
    const retrieved = store.getMessage('msg_user_1');
    assert.equal(retrieved.id, 'msg_user_1');
    assert.equal(Array.isArray(retrieved.attachments), true);
    assert.equal(retrieved.attachments.length, 2);
    assert.equal(retrieved.attachments[0].dataUrl, sampleAttachments[0].dataUrl);

    // Retrieve full session with messages
    const fullSession = store.getSession('sess_1');
    assert.equal(fullSession.messages.length, 1);
    const sessionMsg = fullSession.messages[0];
    assert.equal(sessionMsg.id, 'msg_user_1');
    assert.equal(Array.isArray(sessionMsg.attachments), true);
    assert.equal(sessionMsg.attachments.length, 2);
    assert.equal(sessionMsg.attachments[0].name, 'screenshot.png');
    assert.equal(sessionMsg.attachments[0].dataUrl, sampleAttachments[0].dataUrl);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
