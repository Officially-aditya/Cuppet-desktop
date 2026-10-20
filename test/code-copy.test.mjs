import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { copyCodeBlock } from '../src/renderer/react/code-copy.ts';

// A code block as renderMarkdown emits it: a copy button and a pre > code, inside .md-code-block.
function codeBlock(code = 'npm install') {
  const attributes = {};
  const button = {
    textContent: 'Copy',
    setAttribute: (name, value) => { attributes[name] = value; },
    closest(selector) {
      if (selector === '[data-cuppet-copy]') return button;
      if (selector === '.md-code-block') return block;
      return null;
    },
  };
  const block = { textContent: null, querySelector: (selector) => (selector === 'pre code' ? { textContent: code } : null) };
  return { button, attributes };
}

function bridge(copyText) {
  const copied = [];
  globalThis.window = { cuppet: { native: { copyText: copyText ?? (async (text) => { copied.push(text); }) } } };
  return copied;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('clicking the button copies the block\'s code, not the button label', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const copied = bridge();
    const { button, attributes } = codeBlock('const a = 1;\nconst b = 2;');
    assert.equal(copyCodeBlock(button), true);
    await settle();
    assert.deepEqual(copied, ['const a = 1;\nconst b = 2;']);
    assert.equal(button.textContent, 'Copied');
    assert.equal(attributes['aria-label'], 'Code copied');
  } finally { mock.timers.reset(); }
});

test('the label is restored after the feedback delay', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    bridge();
    const { button, attributes } = codeBlock();
    copyCodeBlock(button);
    await settle();
    mock.timers.tick(1600);
    assert.equal(button.textContent, 'Copy');
    assert.equal(attributes['aria-label'], 'Copy code');
  } finally { mock.timers.reset(); }
});

test('clicking again while feedback is showing still restores the original label', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    bridge();
    const { button } = codeBlock();
    copyCodeBlock(button);
    await settle();
    mock.timers.tick(500);
    copyCodeBlock(button);
    await settle();
    mock.timers.tick(1600);
    assert.equal(button.textContent, 'Copy', 'never gets stuck on "Copied"');
  } finally { mock.timers.reset(); }
});

test('a failing clipboard shows Failed and does not throw', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    bridge(async () => { throw new Error('denied'); });
    const { button, attributes } = codeBlock();
    assert.equal(copyCodeBlock(button), true);
    await settle();
    assert.equal(button.textContent, 'Failed');
    assert.equal(attributes['aria-label'], 'Copy failed');
  } finally { mock.timers.reset(); }
});

test('a missing bridge is reported as a failure rather than a crash', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    globalThis.window = { cuppet: { native: {} } };
    const { button } = codeBlock();
    assert.equal(copyCodeBlock(button), true);
    await settle();
    assert.equal(button.textContent, 'Failed');
  } finally { mock.timers.reset(); }
});

test('clicks that are not on a copy button are left alone', () => {
  const copied = bridge();
  assert.equal(copyCodeBlock({ closest: () => null }), false);
  assert.equal(copyCodeBlock(null), false);
  assert.equal(copyCodeBlock(undefined), false);
  assert.deepEqual(copied, []);
});
