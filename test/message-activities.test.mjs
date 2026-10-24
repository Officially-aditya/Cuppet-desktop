import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationDatabase } from '../src/runtime/database.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cuppet-activity-'));
  const path = join(dir, 'conversation.sqlite');
  const db = new ConversationDatabase(path);
  db.createSession({ id: 'session-1', title: 'Activity test', now: 100 });
  db.appendMessage({ id: 'user-1', sessionId: 'session-1', role: 'user', content: 'hello', now: 101 });
  db.appendMessage({ id: 'assistant-1', sessionId: 'session-1', role: 'assistant', content: '', status: 'streaming', now: 102 });
  return { dir, path, db };
}

test('message activities are sequenced and returned with the session', () => {
  const { dir, db } = fixture();
  try {
    const first = db.appendMessageActivity({
      sessionId: 'session-1',
      messageId: 'assistant-1',
      source: 'provider',
      activity: { type: 'activity.reasoning.delta', text: 'Inspecting state' },
      now: 103,
    });
    const second = db.appendMessageActivity({
      sessionId: 'session-1',
      messageId: 'assistant-1',
      source: 'execution',
      activity: { type: 'activity.tool.opened', callId: 'call-1', tool: 'workspace_read' },
      now: 104,
    });
    const third = db.appendMessageActivity({
      sessionId: 'session-1',
      messageId: 'assistant-1',
      source: 'execution',
      activity: { type: 'activity.tool.closed', callId: 'call-1', tool: 'workspace_read', status: 'success' },
      now: 105,
    });

    assert.equal(first.sequence, 1);
    assert.equal(second.sequence, 2);
    assert.equal(third.sequence, 3);

    const session = db.getSession('session-1');
    assert.deepEqual(session.activities.map((entry) => [entry.sequence, entry.source, entry.activity.type]), [
      [1, 'provider', 'activity.reasoning.delta'],
      [2, 'execution', 'activity.tool.opened'],
      [3, 'execution', 'activity.tool.closed'],
    ]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('message activities survive database restart', () => {
  const { dir, path, db } = fixture();
  try {
    db.appendMessageActivity({
      sessionId: 'session-1',
      messageId: 'assistant-1',
      source: 'provider',
      activity: { type: 'activity.reasoning.delta', text: 'Durable reasoning' },
      now: 103,
    });
    db.close();

    const reopened = new ConversationDatabase(path);
    try {
      const session = reopened.getSession('session-1');
      assert.equal(session.activities.length, 1);
      assert.equal(session.activities[0].messageId, 'assistant-1');
      assert.equal(session.activities[0].activity.text, 'Durable reasoning');
      assert.equal(session.messages.find((message) => message.id === 'assistant-1').status, 'interrupted');
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('forkSession copies canonical message activities to mapped assistant messages', () => {
  const { dir, db } = fixture();
  try {
    db.updateMessage('assistant-1', { status: 'complete', content: 'done', now: 103 });
    db.appendMessageActivity({
      sessionId: 'session-1',
      messageId: 'assistant-1',
      source: 'provider',
      activity: { type: 'activity.reasoning.delta', text: 'Before answer' },
      now: 104,
    });

    const fork = db.forkSession({ sourceSessionId: 'session-1', id: 'session-2', title: 'Fork', now: 200 });
    const copy = db.getSession('session-2');
    assert.equal(copy.activities.length, 1);
    assert.equal(copy.activities[0].messageId, fork.messageMap['assistant-1']);
    assert.equal(copy.activities[0].activity.text, 'Before answer');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('activity counters remain correct after rollback, restart, and message-scoped reads', () => {
  const { dir, path, db } = fixture();
  const append = (messageId) => db.appendMessageActivity({ sessionId: 'session-1', messageId, activity: { type: 'activity.text.delta', text: 'text' } });
  try {
    append('assistant-1');
    assert.throws(() => db.transaction(() => { append('assistant-1'); throw new Error('rollback'); }), /rollback/);
    assert.equal(append('assistant-1').sequence, 2);
    db.appendMessage({ id: 'assistant-2', sessionId: 'session-1', role: 'assistant' });
    append('assistant-2');
    assert.deepEqual(db.listMessageActivities('session-1', { messageIds: ['assistant-2'], limit: 1 }).map((row) => row.messageId), ['assistant-2']);
    assert.deepEqual(db.listMessageActivities('session-1', { messageIds: [] }), []);
    assert.equal(db.listMessageActivities('session-1', { messageIds: ['assistant-1'], limit: 1 }).length, 1);
    const reopened = new ConversationDatabase(path);
    try {
      assert.equal(reopened.appendMessageActivity({ sessionId: 'session-1', messageId: 'assistant-1', activity: {} }).sequence, 3);
    } finally { reopened.close(); }
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('messages-only snapshots include buffered text and never load activities or tool executions', () => {
  const { dir, db } = fixture();
  try {
    db.appendMessageContent('assistant-1', 'first');
    db.appendMessageContent('assistant-1', ' pending');
    db.listMessageActivities = () => assert.fail('messages-only reads must not load activity history');
    db.listToolExecutions = () => assert.fail('messages-only reads must not load tool history');
    assert.equal(db.getSessionMessages('session-1').at(-1).content, 'first pending');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
