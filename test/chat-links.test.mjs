import assert from 'node:assert/strict';
import test from 'node:test';
import { renderMarkdown, inlineProjectPath } from '../src/renderer/react/markdown.ts';
import { isProjectFileTarget, openChatLink, stripLineSuffix } from '../src/renderer/react/project-links.ts';

// A minimal stand-in for a DOM element: closest() resolves to the element itself.
function link(attributes, href = '') {
  const element = {
    href,
    closest: (selector) => (selector.split(',').some((part) => attributes[part.trim().slice(1, -1)] !== undefined) ? element : null),
    getAttribute: (name) => attributes[name] ?? null,
    hasAttribute: (name) => attributes[name] !== undefined,
  };
  return element;
}

function bridge() {
  const calls = { external: [], files: [] };
  globalThis.window = {
    cuppet: {
      native: {
        openExternal: async (href) => { calls.external.push(href); },
        openProjectFile: async (projectId, path) => { calls.files.push([projectId, path]); },
      },
    },
  };
  return calls;
}

test('inline code naming a project file is linked when the markdown is rendered, so history needs no patching', () => {
  const html = renderMarkdown('Edit `src/app.ts:42` and `./README.md`, then run `npm test`, `rm -rf /` and `../secret.ts`.');
  assert.match(html, /<code data-cuppet-project-file="src\/app\.ts:42" role="link" tabindex="0">src\/app\.ts:42<\/code>/);
  assert.match(html, /<code data-cuppet-project-file="README\.md" role="link" tabindex="0">\.\/README\.md<\/code>/);
  assert.match(html, /<code>npm test<\/code>/);
  assert.match(html, /<code>rm -rf \/<\/code>/);
  assert.match(html, /<code>\.\.\/secret\.ts<\/code>/, 'paths that leave the project are never linked');
});

test('only plain file references are linked, never commands, URLs or shell syntax', () => {
  for (const value of ['npm run build', 'https://example.com/a.ts', 'cat a.ts | sh', 'a.ts; rm b', '$(a.ts)', '`a.ts`', 'a b.ts', '..', '../a.ts', 'src/../a.ts']) {
    assert.equal(inlineProjectPath(value), '', value);
  }
  assert.equal(inlineProjectPath('C:\\Users\\me\\a.py'), 'C:/Users/me/a.py');
  assert.equal(inlineProjectPath('Dockerfile'), 'Dockerfile');
});

test('file paths open against the active project with the line suffix removed', () => {
  const calls = bridge();
  assert.equal(stripLineSuffix('src/a.ts:12:3-14:1'), 'src/a.ts');
  assert.equal(openChatLink('p1', link({ 'data-cuppet-project-file': 'src/a.ts:12' })), true);
  assert.deepEqual(calls.files, [['p1', 'src/a.ts']]);
  assert.deepEqual(calls.external, []);
});

test('a file reference without a project is consumed but opens nothing', () => {
  const calls = bridge();
  assert.equal(openChatLink(null, link({ 'data-cuppet-project-file': 'src/a.ts' })), true);
  assert.deepEqual(calls.files, []);
});

test('web links open through the native bridge', () => {
  const calls = bridge();
  assert.equal(openChatLink('p1', link({ 'data-cuppet-external': 'true' }, 'https://example.com/x')), true);
  assert.deepEqual(calls.external, ['https://example.com/x']);
  assert.deepEqual(calls.files, []);
});

test('anything that is not a chat link is left alone', () => {
  const calls = bridge();
  assert.equal(openChatLink('p1', { closest: () => null }), false);
  assert.equal(openChatLink('p1', null), false);
  assert.equal(isProjectFileTarget(link({ 'data-cuppet-external': 'true' }, 'https://x.y')), false);
  assert.equal(isProjectFileTarget(link({ 'data-cuppet-project-file': 'a.ts' })), true);
  assert.deepEqual([calls.files, calls.external], [[], []]);
});

test('a failing native bridge never throws into the click handler', async () => {
  globalThis.window = { cuppet: { native: { openExternal: () => Promise.reject(new Error('denied')), openProjectFile: () => { throw new Error('boom'); } } } };
  assert.equal(openChatLink('p1', link({ 'data-cuppet-external': 'true' }, 'https://example.com')), true);
  assert.equal(openChatLink('p1', link({ 'data-cuppet-project-file': 'src/a.ts' })), true, 'a synchronous throw is contained too');
  await new Promise((resolve) => setTimeout(resolve, 5));
});
