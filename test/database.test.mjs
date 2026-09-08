import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationDatabase } from '../src/runtime/database.mjs';

test('SQLite conversations survive a runtime restart and stale streams become interrupted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-db-'));
  const path = join(dir, 'conversations.sqlite3');
  try {
    const first = new ConversationDatabase(path);
    first.createSession({ id: 's1', title: 'Persistence' });
    first.appendMessage({ id: 'u1', sessionId: 's1', role: 'user', content: 'hello' });
    first.appendMessage({ id: 'a1', sessionId: 's1', role: 'assistant', content: 'partial', status: 'streaming' });
    first.close();

    const second = new ConversationDatabase(path);
    const restored = second.getSession('s1');
    assert.equal(restored.title, 'Persistence');
    assert.deepEqual(restored.messages.map((message) => [message.role, message.content, message.status]), [
      ['user', 'hello', 'complete'],
      ['assistant', 'partial', 'interrupted'],
    ]);
    second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
