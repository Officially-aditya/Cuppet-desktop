import assert from 'node:assert/strict';
import test from 'node:test';
import { readTraceOpen, workWords, writeTraceOpen } from '../src/renderer/react/trace-presentation.ts';
import { installSessionRetentionCleanup } from '../src/renderer/react/session-retention.ts';

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
test.beforeEach(() => {
  const values = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  } });
});
test.afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else delete globalThis.localStorage;
});

test('disclosures restore independently for each message and fold when a live turn finishes', () => {
  assert.equal(readTraceOpen('a', true), true);
  writeTraceOpen('a', true, true);
  assert.equal(readTraceOpen('a', true), true);
  assert.equal(readTraceOpen('b', true), true);
  assert.equal(readTraceOpen('a', false), false, 'live expansion cannot reopen a finished turn');
  writeTraceOpen('a', true, false);
  assert.equal(readTraceOpen('a', true), false, 'a manually folded live trace stays folded');
  writeTraceOpen('a', false, true);
  assert.equal(readTraceOpen('a', false), true);
  assert.equal(readTraceOpen('a', true), true);
  writeTraceOpen('a', false, false);
  assert.equal(readTraceOpen('a', false), false);
  assert.equal(localStorage.getItem('cuppet.desktop.trace.a'), 'finished:closed');
});

test('unavailable or legacy storage cannot break a disclosure', () => {
  localStorage.setItem('cuppet.desktop.trace.old', '1');
  assert.equal(readTraceOpen('old', false), false);
  assert.equal(readTraceOpen('stopped', false, true), true);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Storage denied'); } });
  assert.equal(readTraceOpen('a', true), true);
  assert.doesNotThrow(() => writeTraceOpen('a', true, true));
  assert.doesNotThrow(() => writeTraceOpen('a', true, false));
});

test('deleted-chat cleanup removes the persisted disclosure preference', () => {
  const originalWindow = globalThis.window;
  let onEvent;
  globalThis.window = { cuppet: { onEvent(callback) { onEvent = callback; return () => {}; } } };
  try {
    writeTraceOpen('deleted', false, true);
    writeTraceOpen('kept', false, true);
    installSessionRetentionCleanup();
    onEvent({ type: 'session.purged', messageIds: ['deleted'], sessionId: 'session' });
    assert.equal(readTraceOpen('deleted', false), false);
    assert.equal(readTraceOpen('kept', false), true);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('architecture words vary between activities but retain the same active/past pair across rerenders', () => {
  const selected = new Map();
  for (let index = 0; index < 100; index++) {
    const id = `message-${index}:work`;
    const words = workWords(id);
    assert.deepEqual(workWords(id), words);
    assert.ok(words.active.endsWith('ing'));
    assert.ok(words.done && words.done !== words.active);
    selected.set(words.active, words.done);
  }
  assert.ok(selected.size >= 8);
  assert.equal(selected.get('Forging'), 'Forged');
  assert.equal(selected.get('Smithering'), 'Smithered');
});
