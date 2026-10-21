import assert from 'node:assert/strict';
import test from 'node:test';
import { attachModalBehavior, focusableWithin } from '../src/renderer/react/use-modal-behavior.ts';

// A tiny fake document: focus() moves activeElement, and press() dispatches a keydown to every listener.
function makeDocument() {
  const listeners = [];
  const doc = {
    body: { name: 'body' },
    activeElement: null,
    openDialog: false,
    querySelector: (selector) => (selector === 'dialog[open]' && doc.openDialog ? { name: 'dialog' } : null),
    addEventListener: (_type, listener) => listeners.push(listener),
    removeEventListener: (_type, listener) => { const at = listeners.indexOf(listener); if (at !== -1) listeners.splice(at, 1); },
    listenerCount: () => listeners.length,
    press(key, { shift = false, defaultPrevented = false } = {}) {
      const event = { key, shiftKey: shift, defaultPrevented, prevented: false, preventDefault() { this.prevented = true; this.defaultPrevented = true; } };
      for (const listener of [...listeners]) listener(event);
      return event;
    },
  };
  doc.activeElement = doc.body;
  return doc;
}

function element(doc, name, extra = {}) {
  const { visible = true, tabindex = null, ...props } = extra;
  return {
    name, isConnected: true, ...props,
    focus() { doc.activeElement = this; },
    getClientRects: () => ({ length: visible ? 1 : 0 }),
    getAttribute: (attribute) => (attribute === 'tabindex' ? tabindex : null),
  };
}

function modal(doc, names = ['close', 'name', 'save']) {
  const children = names.map((name) => element(doc, name));
  const root = {
    name: 'root', children,
    focus() { doc.activeElement = this; },
    contains: (node) => node === root || children.includes(node),
    querySelectorAll: () => children,
  };
  return { root, children };
}

test('focus moves into the modal on open and returns to where it was on close', () => {
  const doc = makeDocument();
  const opener = element(doc, 'opener'); opener.focus();
  const { root, children } = modal(doc);
  const detach = attachModalBehavior(root, () => {}, doc);
  assert.equal(doc.activeElement, children[0], 'the first focusable element gets focus');
  detach();
  assert.equal(doc.activeElement, opener, 'focus returns to the opener');
});

test('focus that is already inside the modal (an autofocused field) is left where it is', () => {
  const doc = makeDocument();
  const { root, children } = modal(doc);
  children[1].focus();
  attachModalBehavior(root, () => {}, doc);
  assert.equal(doc.activeElement, children[1]);
});

test('a modal with nothing focusable takes focus itself', () => {
  const doc = makeDocument();
  const { root } = modal(doc, []);
  attachModalBehavior(root, () => {}, doc);
  assert.equal(doc.activeElement, root);
});

test('Escape closes the modal and is consumed', () => {
  const doc = makeDocument();
  const { root } = modal(doc);
  let closed = 0;
  attachModalBehavior(root, () => { closed++; }, doc);
  const event = doc.press('Escape');
  assert.equal(closed, 1);
  assert.equal(event.prevented, true);
});

test('Escape that something inside already handled (an open dropdown) does not also close the modal', () => {
  const doc = makeDocument();
  const { root } = modal(doc);
  let closed = 0;
  attachModalBehavior(root, () => { closed++; }, doc);
  doc.press('Escape', { defaultPrevented: true });
  assert.equal(closed, 0);
});

test('Escape while a native dialog is open on top closes only that dialog, not the modal beneath', () => {
  const doc = makeDocument();
  const { root } = modal(doc);
  let closed = 0;
  attachModalBehavior(root, () => { closed++; }, doc);
  doc.openDialog = true;
  doc.press('Escape');
  assert.equal(closed, 0);
  doc.openDialog = false;
  doc.press('Escape');
  assert.equal(closed, 1);
});

test('with stacked modals only the newest reacts, then the one beneath once it closes', () => {
  const doc = makeDocument();
  const first = modal(doc); const second = modal(doc);
  const log = [];
  const detachFirst = attachModalBehavior(first.root, () => log.push('first'), doc);
  const detachSecond = attachModalBehavior(second.root, () => log.push('second'), doc);
  doc.press('Escape');
  assert.deepEqual(log, ['second']);
  detachSecond();
  doc.press('Escape');
  assert.deepEqual(log, ['second', 'first']);
  detachFirst();
  doc.press('Escape');
  assert.deepEqual(log, ['second', 'first'], 'a closed modal no longer listens');
  assert.equal(doc.listenerCount(), 0);
});

test('Tab on the last element wraps to the first, and Shift+Tab on the first wraps to the last', () => {
  const doc = makeDocument();
  const { root, children } = modal(doc);
  attachModalBehavior(root, () => {}, doc);
  children[2].focus();
  assert.equal(doc.press('Tab').prevented, true);
  assert.equal(doc.activeElement, children[0]);
  assert.equal(doc.press('Tab', { shift: true }).prevented, true);
  assert.equal(doc.activeElement, children[2]);
});

test('Tab in the middle is left to the browser', () => {
  const doc = makeDocument();
  const { root, children } = modal(doc);
  attachModalBehavior(root, () => {}, doc);
  children[1].focus();
  assert.equal(doc.press('Tab').prevented, false);
  assert.equal(doc.press('Tab', { shift: true }).prevented, false);
  assert.equal(doc.activeElement, children[1]);
});

test('Shift+Tab from the modal element itself wraps to the last control', () => {
  const doc = makeDocument();
  const { root, children } = modal(doc);
  attachModalBehavior(root, () => {}, doc);
  root.focus();
  doc.press('Tab', { shift: true });
  assert.equal(doc.activeElement, children[2]);
});

test('if focus fell to the page body, Tab brings it back to the first control and Shift+Tab to the last', () => {
  const doc = makeDocument();
  const { root, children } = modal(doc);
  attachModalBehavior(root, () => {}, doc);
  doc.activeElement = doc.body;
  doc.press('Tab');
  assert.equal(doc.activeElement, children[0]);
  doc.activeElement = doc.body;
  doc.press('Tab', { shift: true });
  assert.equal(doc.activeElement, children[2]);
});

test('focus inside something portalled out of the modal (a dropdown menu) is not hijacked', () => {
  const doc = makeDocument();
  const { root, children } = modal(doc);
  attachModalBehavior(root, () => {}, doc);
  const menuItem = element(doc, 'menu-item'); menuItem.focus();
  assert.equal(doc.press('Tab').prevented, false);
  assert.equal(doc.activeElement, menuItem);
  assert.notEqual(doc.activeElement, children[0]);
});

test('a modal with nothing focusable keeps Tab inside by holding focus on itself', () => {
  const doc = makeDocument();
  const { root } = modal(doc, []);
  attachModalBehavior(root, () => {}, doc);
  assert.equal(doc.press('Tab').prevented, true);
  assert.equal(doc.activeElement, root);
});

test('focus is not taken back if the user moved it somewhere real before closing', () => {
  const doc = makeDocument();
  const opener = element(doc, 'opener'); opener.focus();
  const { root } = modal(doc);
  const detach = attachModalBehavior(root, () => {}, doc);
  const elsewhere = element(doc, 'elsewhere'); elsewhere.focus();
  detach();
  assert.equal(doc.activeElement, elsewhere);
});

test('focus returns to the opener when the modal unmounts and focus has dropped to the body', () => {
  const doc = makeDocument();
  const opener = element(doc, 'opener'); opener.focus();
  const { root } = modal(doc);
  const detach = attachModalBehavior(root, () => {}, doc);
  doc.activeElement = doc.body; // the focused control was removed with the modal
  detach();
  assert.equal(doc.activeElement, opener);
});

test('an opener that has been removed is not focused', () => {
  const doc = makeDocument();
  const opener = element(doc, 'opener'); opener.focus();
  const { root } = modal(doc);
  const detach = attachModalBehavior(root, () => {}, doc);
  opener.isConnected = false;
  doc.activeElement = doc.body;
  detach();
  assert.equal(doc.activeElement, doc.body);
});

test('disabled, hidden, display:none and tabindex=-1 elements are not tab stops', () => {
  const doc = makeDocument();
  const keep = element(doc, 'keep');
  const root = {
    focus() {}, contains: () => true,
    querySelectorAll: () => [
      keep, element(doc, 'disabled', { disabled: true }), element(doc, 'hidden', { hidden: true }), element(doc, 'hiddenInput', { type: 'hidden' }),
      element(doc, 'offscreen', { visible: false }), element(doc, 'skip', { tabindex: '-1' }), element(doc, 'zero', { tabindex: '0' }),
    ],
  };
  assert.deepEqual(focusableWithin(root).map((item) => item.name), ['keep', 'zero']);
});

test('keys other than Escape and Tab are ignored', () => {
  const doc = makeDocument();
  const { root } = modal(doc);
  let closed = 0;
  attachModalBehavior(root, () => { closed++; }, doc);
  for (const key of ['Enter', ' ', 'ArrowDown', 'a']) assert.equal(doc.press(key).prevented, false);
  assert.equal(closed, 0);
});
