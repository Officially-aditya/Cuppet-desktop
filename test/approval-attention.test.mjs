import assert from 'node:assert/strict';
import test from 'node:test';
import { createApprovalAttention } from '../src/main/approval-attention.mjs';

function fixture(focused = false) {
  const badges = [], flashes = [], notifications = [], opened = [], windowActions = [];
  const window = {
    isFocused: () => focused, isMinimized: () => true,
    flashFrame: (value) => flashes.push(value),
    restore: () => windowActions.push('restore'),
    show: () => windowActions.push('show'),
    focus: () => windowActions.push('focus'),
    webContents: { send: (...args) => opened.push(args) },
  };
  const attention = createApprovalAttention({
    getWindow: () => window,
    setBadgeCount: (count) => badges.push(count),
    notify: (options) => {
      const notice = { ...options, closed: false, close() { this.closed = true; } };
      notifications.push(notice);
      return notice;
    },
  });
  return { attention, badges, flashes, notifications, opened, windowActions };
}

test('background approval requests are deduplicated, badged and open their own chat', () => {
  const { attention, badges, flashes, notifications, opened, windowActions } = fixture();
  const event = { type: 'permission.requested', request: { id: 'approval', sessionId: 'chat' } };
  attention.handle(event);
  attention.handle(event);
  assert.deepEqual(badges, [1]);
  assert.deepEqual(flashes, [true]);
  assert.equal(notifications.length, 1);
  notifications[0].onClick();
  assert.deepEqual(windowActions, ['restore', 'show', 'focus']);
  assert.deepEqual(opened, [['cuppet:attention:open-session', 'chat']]);
  attention.handle({ type: 'permission.resolved', requestId: 'approval' });
  assert.equal(notifications[0].closed, true);
  assert.deepEqual(badges, [1, 0]);
  assert.equal(flashes.at(-1), false);
});

test('focused windows keep pending badges without issuing a notification', () => {
  const { attention, badges, notifications } = fixture(true);
  attention.handle({ type: 'question.requested', request: { id: 'question', sessionId: 'chat' } });
  assert.deepEqual(badges, [1]);
  assert.equal(notifications.length, 0);
  attention.handle({ type: 'question.resolved', requestId: 'question' });
  assert.equal(badges.at(-1), 0);
});

test('focus dismisses notices, session cleanup keeps other requests, and dispose clears badges', () => {
  const { attention, badges, notifications, flashes } = fixture();
  attention.handle({ type: 'permission.requested', request: { id: 'first', sessionId: 'one' } });
  attention.handle({ type: 'question.requested', request: { id: 'second', sessionId: 'two' } });
  attention.focused();
  assert.ok(notifications.every((notice) => notice.closed));
  assert.equal(flashes.at(-1), false);
  assert.equal(badges.at(-1), 2);
  attention.handle({ type: 'run.finished', sessionId: 'one' });
  assert.equal(badges.at(-1), 1);
  attention.handle({ type: 'session.deleted', sessionId: 'two' });
  assert.equal(badges.at(-1), 0);
  attention.dispose();
  assert.equal(badges.at(-1), 0);
});
