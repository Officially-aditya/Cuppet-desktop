import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../src/renderer/markdown.mjs';

test('renders readable markdown without allowing raw HTML', () => {
  const html = renderMarkdown('# Title\n\n**bold** and `code`\n\n- one\n- two\n\n```js\nconst x = 1;\n```');
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /language-js/);
  assert.doesNotMatch(renderMarkdown('<script>alert(1)</script>'), /<script>/);
});

test('blocks unsafe markdown link schemes and keeps safe links', () => {
  const unsafe = renderMarkdown('[x](javascript:alert(1))');
  assert.doesNotMatch(unsafe, /href=/);
  const safe = renderMarkdown('[OpenAI](https://openai.com)');
  assert.match(safe, /href="https:\/\/openai\.com"/);
  assert.match(safe, /rel="noreferrer noopener"/);
});

test('renders simple markdown tables', () => {
  const html = renderMarkdown('| A | B |\n| --- | --- |\n| 1 | 2 |');
  assert.match(html, /<table>/);
  assert.match(html, /<th>A<\/th>/);
  assert.match(html, /<td>2<\/td>/);
});
