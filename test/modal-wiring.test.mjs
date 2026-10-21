import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadModule } from './helpers/load-tsx.mjs';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const read = (file) => readFile(path(`../src/renderer/react/${file}.tsx`), 'utf8');

// Settings, Remote, Add project and New chat had no Escape handling and no focus management (UI-22).
const MODALS = ['SettingsModal', 'RemoteModal', 'AddProjectModal', 'NewChatModal'];

for (const name of MODALS) {
  test(`${name} gets Escape, a focus trap and focus return from the shared hook`, async () => {
    const source = await read(name);
    assert.match(source, /import \{ useModalBehavior \} from '\.\/use-modal-behavior';/);
    assert.match(source, /const dialogRef = useRef<HTMLElement>\(null\);\n\s+useModalBehavior\(dialogRef, onClose\);/);
    // The hook is attached to the dialog section itself, which can hold focus as a fallback.
    assert.match(source, /<section ref=\{dialogRef\} tabIndex=\{-1\} className="react-modal /);
    assert.match(source, /role="dialog" aria-modal="true" aria-labelledby="/);
  });
}

test('the hook is called unconditionally, before any early return, in each modal', async () => {
  for (const name of MODALS) {
    const source = await read(name);
    const hookAt = source.indexOf('useModalBehavior(dialogRef, onClose)');
    const firstReturn = source.indexOf('\n  return', source.indexOf('export function'));
    assert.ok(hookAt > 0 && hookAt < firstReturn, `${name}: hook runs before the first return`);
    assert.doesNotMatch(source.slice(source.indexOf('export function'), hookAt), /\n\s+if \(.*\) return/, `${name}: no early return precedes the hook`);
  }
});

test('the existing close paths are untouched: backdrop click and the close button still call onClose', async () => {
  for (const name of MODALS) {
    const source = await read(name);
    assert.match(source, /<div className="modal-backdrop" role="presentation" onMouseDown=\{onClose\}>/, name);
    assert.match(source, /aria-label="Close"|>Cancel</, name);
  }
});

test('New chat and Add project render a focusable dialog with the hook attached', () => {
  for (const [file, name, props] of [
    ['NewChatModal', 'NewChatModal', { projects: [], selectedProjectId: null, onClose() {}, onStart() {} }],
    ['AddProjectModal', 'AddProjectModal', { onClose() {}, onAdded() {}, onError() {} }],
  ]) {
    const Component = loadModule(path(`../src/renderer/react/${file}.tsx`))[name];
    const html = renderToStaticMarkup(React.createElement(Component, props));
    assert.match(html, /<section tabindex="-1" class="react-modal settings-dialog" role="dialog" aria-modal="true" aria-labelledby="[^"]+">/, name);
  }
});

test('modals that already handle Escape keep their own handlers rather than gaining a second one', async () => {
  for (const name of ['SearchModal', 'DiffViewerModal', 'ImageLightboxModal']) {
    const source = await read(name);
    assert.match(source, /Escape/, name);
    assert.doesNotMatch(source, /useModalBehavior/, name);
  }
});
