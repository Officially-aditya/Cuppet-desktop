import assert from 'node:assert/strict';
import test from 'node:test';
import { observeTraceVisibility, readTraceOpen, splitTraceText, writeTraceOpen } from '../src/renderer/react/trace-presentation.ts';
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
  assert.equal(readTraceOpen('a', true), false);
  writeTraceOpen('a', true, true);
  assert.equal(readTraceOpen('a', true), true);
  assert.equal(readTraceOpen('b', true), false);
  assert.equal(readTraceOpen('a', false), false, 'live expansion cannot reopen a finished turn');
  writeTraceOpen('a', false, true);
  assert.equal(readTraceOpen('a', false), true);
  assert.equal(readTraceOpen('a', true), false);
  writeTraceOpen('a', false, false);
  assert.equal(readTraceOpen('a', false), false);
  assert.equal(localStorage.getItem('cuppet.desktop.trace.a'), null);
});

test('unavailable or legacy storage cannot break a disclosure', () => {
  localStorage.setItem('cuppet.desktop.trace.old', '1');
  assert.equal(readTraceOpen('old', false), false);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Storage denied'); } });
  assert.equal(readTraceOpen('a', true), false);
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

test('label morphs preserve shared text and animate only changed counts', () => {
  assert.deepEqual(splitTraceText('Reading', 'Read'), { prefix: 'Read', removed: 'ing', added: '', suffix: '' });
  assert.deepEqual(splitTraceText('Read 4 files', 'Read 5 files'), { prefix: 'Read ', removed: '4', added: '5', suffix: ' files' });
  assert.deepEqual(splitTraceText('Read 9 files', 'Read 10 files'), { prefix: 'Read ', removed: '9', added: '10', suffix: ' files' });
  for (const [before, after] of [['', 'Working…'], ['same', 'same'], ['😀 file', '😃 file'], ['abcdef', 'xy']]) {
    const { prefix, removed, added, suffix } = splitTraceText(before, after);
    assert.equal(prefix + removed + suffix, before);
    assert.equal(prefix + added + suffix, after);
    assert.equal(added.isWellFormed(), true);
  }
});

test('trace animation visibility follows scrolling and window visibility and cleans up on unmount', () => {
  const originalObserver = globalThis.IntersectionObserver;
  let onIntersect, onVisibility, observed, disconnected = false;
  const doc = { visibilityState: 'visible',
    addEventListener(type, listener) { assert.equal(type, 'visibilitychange'); onVisibility = listener; },
    removeEventListener(type, listener) { assert.equal(type, 'visibilitychange'); assert.equal(listener, onVisibility); onVisibility = null; },
  };
  const header = {};
  const node = { dataset: {}, ownerDocument: doc, querySelector: () => header };
  globalThis.IntersectionObserver = class {
    constructor(callback) { onIntersect = callback; }
    observe(target) { observed = target; }
    disconnect() { disconnected = true; }
  };
  try {
    const dispose = observeTraceVisibility(node);
    assert.equal(observed, header, 'an expanded timeline must not keep an offscreen header animating');
    assert.equal(node.dataset.traceVisible, 'false');
    onIntersect([{ isIntersecting: true }]);
    assert.equal(node.dataset.traceVisible, 'true');
    doc.visibilityState = 'hidden'; onVisibility();
    assert.equal(node.dataset.traceVisible, 'false');
    doc.visibilityState = 'visible'; onVisibility();
    assert.equal(node.dataset.traceVisible, 'true');
    onIntersect([{ isIntersecting: false }]);
    assert.equal(node.dataset.traceVisible, 'false');
    dispose();
    assert.equal(disconnected, true);
    assert.equal(onVisibility, null);
    assert.equal(node.dataset.traceVisible, undefined);
  } finally {
    if (originalObserver === undefined) delete globalThis.IntersectionObserver;
    else globalThis.IntersectionObserver = originalObserver;
  }
});
