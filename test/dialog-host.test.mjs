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
const { DialogContent } = loadModule(path('../src/renderer/react/DialogHost.tsx'));

const render = (request) => renderToStaticMarkup(React.createElement(DialogContent, { request: { id: 1, ...request }, titleId: 'title', messageId: 'message' }));

test('a confirmation puts Cancel first, so the safe action is the default focus, and the confirm button is explicit', () => {
  const html = render({ kind: 'confirm', title: 'Remove project?', message: 'Files stay on disk.', confirmLabel: 'Remove project', destructive: true });
  assert.ok(html.indexOf('>Cancel<') > 0 && html.indexOf('>Cancel<') < html.indexOf('>Remove project<'));
  assert.match(html, /<button type="submit" class="cuppet-dialog-button primary danger">Remove project<\/button>/);
  assert.match(html, /<h2 class="cuppet-dialog-title" id="title">Remove project\?<\/h2>/);
  assert.match(html, /<p class="cuppet-dialog-message" id="message">Files stay on disk\.<\/p>/);
  assert.doesNotMatch(html, /autofocus|autoFocus/i);
});

test('a confirmation without a custom label says Confirm, and is not styled destructive', () => {
  const html = render({ kind: 'confirm', title: 'Archive?' });
  assert.match(html, /class="cuppet-dialog-button primary">Confirm<\/button>/);
  assert.doesNotMatch(html, /danger/);
});

test('a text field is labelled for its input and cannot be submitted empty', () => {
  const html = render({ kind: 'form', title: 'Steer', fields: [{ name: 'value', label: 'Steer instruction', placeholder: 'What should change?' }] });
  const id = html.match(/<label for="([^"]+)">Steer instruction<\/label>/)[1];
  assert.ok(html.includes(`<input id="${id}" type="text"`), 'the label points at the input');
  assert.match(html, /placeholder="What should change\?"/);
  assert.match(html, /<button type="submit" class="cuppet-dialog-button primary" disabled="">OK<\/button>/);
});

test('a field with a default value can be submitted straight away', () => {
  const html = render({ kind: 'form', title: 'Rename', fields: [{ name: 'value', label: 'Name', defaultValue: 'Old name' }] });
  assert.match(html, /value="Old name"/);
  assert.doesNotMatch(html, /disabled=""/);
});

test('an optional field does not block submitting', () => {
  const html = render({ kind: 'form', title: 'Note', fields: [{ name: 'value', label: 'Note', required: false }] });
  assert.doesNotMatch(html, /disabled=""/);
});

test('a whitespace-only default does not count as an answer', () => {
  const html = render({ kind: 'form', title: 'x', fields: [{ name: 'value', label: 'x', defaultValue: '   ' }] });
  assert.match(html, /disabled=""/);
});

test('a multi-line field is a textarea and every field of a form is rendered', () => {
  const html = render({ kind: 'form', title: 'Remember', fields: [{ name: 'key', label: 'Key' }, { name: 'value', label: 'Value', multiline: true }] });
  assert.equal((html.match(/<input /g) || []).length, 1);
  assert.equal((html.match(/<textarea /g) || []).length, 1);
  assert.equal((html.match(/<label for=/g) || []).length, 2);
});

test('a choice is a labelled radio group with the default selected and descriptions shown', () => {
  const html = render({
    kind: 'choice', title: 'Mode', defaultValue: 'build',
    options: [{ value: 'plan', label: 'Plan', description: 'Read-only' }, { value: 'build', label: 'Build', description: 'Can edit files' }],
  });
  assert.match(html, /role="radiogroup" aria-labelledby="title"/);
  assert.match(html, /checked="" value="build"/);
  assert.doesNotMatch(html, /checked="" value="plan"/);
  assert.match(html, /<small>Read-only<\/small>/);
});

test('a choice whose default is not an option falls back to the first option', () => {
  const html = render({ kind: 'choice', title: 'Scope', defaultValue: 'nope', options: [{ value: 'session', label: 'Session' }, { value: 'global', label: 'Global' }] });
  assert.match(html, /checked="" value="session"/);
  assert.doesNotMatch(html, /checked="" value="global"/);
});

test('the host uses a native modal dialog and routes Escape and backdrop clicks through the queue', async () => {
  const source = await readFile(path('../src/renderer/react/DialogHost.tsx'), 'utf8');
  assert.match(source, /showModal\(\)/);
  assert.match(source, /onCancel=\{\(event\) => \{ event\.preventDefault\(\); cancelRequest\(request\.id\); \}\}/);
  assert.match(source, /event\.target === event\.currentTarget/);
  assert.match(source, /useEffect\(\(\) => \(\) => cancelAll\(\), \[\]\)/);
  assert.match(source, /Ctrl\/Cmd\+Enter/);
});

test('the stylesheet uses theme variables only, which both themes define', async () => {
  const css = await readFile(path('../src/renderer/dialog.css'), 'utf8');
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /#(?!c0443e|ffffff|78aaf1)[0-9a-f]{3,8}\b/i, 'no stray hard-coded colours beyond the danger and focus colours');
  for (const variable of ['--panel', '--panel-2', '--line', '--muted', '--text', '--accent', '--accent-text']) assert.ok(css.includes(`var(${variable})`), variable);
  assert.match(css, /prefers-reduced-motion/);
  assert.doesNotMatch(css, /outline:\s*0\b|outline:\s*none/);
});
