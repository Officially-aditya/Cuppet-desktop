import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationDatabase } from '../src/runtime/database.mjs';
import { RuntimeService } from '../src/runtime/service.mjs';
import { projectSessionPayload } from '../src/runtime/session-payload.mjs';
import { sessionProjection } from '../src/runtime/remote/session-projection.mjs';
import { validateIpcArguments } from '../src/shared/ipc-contract.mjs';
import { seedChatSwitchFixture } from '../benchmarks/chat-switch.mjs';

const largeImage = 'data:image/png;base64,' + 'A'.repeat(1024 * 1024);

test('large image payloads become metadata without mutating stored/provider attachments', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-attachment-payload-'));
  const path = join(dir, 'db.sqlite3');
  const db = new ConversationDatabase(path);
  const runtime = new RuntimeService({ database: db, databasePath: path });
  t.after(async () => { await runtime.close(); db.close(); await rm(dir, { recursive: true, force: true }); });
  db.createSession({ id: 's1' });
  db.createSession({ id: 'other' });
  db.appendMessage({ id: 'm1', sessionId: 's1', role: 'user', attachments: [
    { name: 'notes.txt' }, { name: 'image.png', mime: 'image/png', size: 1024, dataUrl: largeImage },
  ] });
  const payload = await runtime.handle('session.get', { sessionId: 's1' });
  assert.deepEqual(payload.messages[0].attachments[1], { name: 'image.png', mime: 'image/png', size: 1024, hasData: true });
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 2048);
  const attachment = await runtime.handle('session.attachment', { sessionId: 's1', messageId: 'm1', index: 1 });
  assert.equal(attachment.dataUrl, largeImage);
  assert.equal(db.getSession('s1').messages[0].attachments[1].dataUrl, largeImage);
  await assert.rejects(runtime.handle('session.attachment', { sessionId: 'other', messageId: 'm1', index: 1 }), /does not belong/);
  await assert.rejects(runtime.handle('session.attachment', { sessionId: 's1', messageId: 'missing', index: 1 }), /does not belong/);
  for (const index of [-1, 16, 0.5]) await assert.rejects(runtime.handle('session.attachment', { sessionId: 's1', messageId: 'm1', index }), /index/);
  assert.equal(await runtime.handle('session.attachment', { sessionId: 's1', messageId: 'm1', index: 2 }), null);
  const remote = sessionProjection(payload);
  assert.equal(JSON.stringify(remote).includes(largeImage), false);
  assert.ok(Buffer.byteLength(JSON.stringify(remote)) < 256 * 1024);
});

test('only attachment data URLs above the 32 KB boundary are stripped', () => {
  const attachments = [{ name: 'inline', dataUrl: 'A'.repeat(32 * 1024) }, { name: 'lazy', dataUrl: 'A'.repeat(32 * 1024 + 1) }];
  const projected = projectSessionPayload({ messages: [{ attachments }] });
  assert.equal(projected.messages[0].attachments[0].dataUrl.length, 32 * 1024);
  assert.equal(projected.messages[0].attachments[1].dataUrl, undefined);
  assert.equal(projected.messages[0].attachments[1].hasData, true);
  assert.equal(attachments[1].dataUrl.length, 32 * 1024 + 1);
});

test('attachment indices and history window options are validated at the IPC boundary', () => {
  assert.doesNotThrow(() => validateIpcArguments('sessions.attachment', ['s', 'm', 0]));
  for (const index of [-1, 16, 0.2, '0', undefined]) assert.throws(() => validateIpcArguments('sessions.attachment', ['s', 'm', index]), /index/);
  for (const options of [{ limit: 0 }, { limit: 10001 }, { beforeSequence: -1 }, { beforeSequence: 1.2 }, { unexpected: true }]) {
    assert.throws(() => validateIpcArguments('sessions.get', ['s', options]), /options/);
  }
});

test('the 1000-message benchmark with three images fits the 250 KB session budget', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-payload-budget-'));
  const db = new ConversationDatabase(join(dir, 'db.sqlite3'));
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  seedChatSwitchFixture(db);
  const payload = projectSessionPayload(db.getSessionWindow('benchmark-history'));
  assert.equal(payload.messages.length, 60);
  assert.equal(payload.activities.length, 600);
  assert.equal(payload.messages.flatMap(message => message.attachments ?? []).filter(attachment => attachment.hasData).length, 3);
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 250 * 1024);
});
