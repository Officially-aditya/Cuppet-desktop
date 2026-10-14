import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, renderInline } from '../src/renderer/react/markdown.ts';

test('markdown parser renders image syntax with data URIs', () => {
  const input = 'Here is a screenshot: ![Screenshot](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==)';
  const html = renderInline(input);
  assert.match(html, /<img\s+src="data:image\/png;base64,[^"]+"\s+alt="Screenshot"\s+class="markdown-image"\s+loading="lazy"\s*\/>/);
  assert.match(html, /<span class="md-image-wrap">/);
});

test('markdown parser renders image syntax with https URLs', () => {
  const input = 'Look at this logo: ![Cuppet Logo](https://example.com/logo.png)';
  const html = renderInline(input);
  assert.match(html, /<img\s+src="https:\/\/example\.com\/logo\.png"\s+alt="Cuppet Logo"\s+class="markdown-image"\s+loading="lazy"\s*\/>/);
});

test('markdown parser does not break standard markdown links', () => {
  const input = 'Check out [our website](https://example.com) for details.';
  const html = renderInline(input);
  assert.match(html, /<a href="https:\/\/example\.com"[^>]*>our website<\/a>/);
  assert.doesNotMatch(html, /<img/);
});

test('markdown parser escapes unsafe image protocols', () => {
  const input = 'Malicious: ![hack](javascript:alert(1))';
  const html = renderInline(input);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /hack/);
});

test('full renderMarkdown parses blocks containing images', () => {
  const markdown = '# Analysis\n\n![Graph](data:image/webp;base64,UklGRkAAAABXRUJQVlA4IDQAAADwAQCdASoBAAEAAQAcJaACdLoAAP7/2QAA)\n\nDone.';
  const html = renderMarkdown(markdown);
  assert.match(html, /<h1>Analysis<\/h1>/);
  assert.match(html, /class="markdown-image"/);
  assert.match(html, /<p>Done\.<\/p>/);
});

test('file links preserve absolute paths, spaces, file URLs and line numbers', () => {
  for (const [input, path] of [
    ['[Source](/workspace/src/main.ts:42)', '/workspace/src/main.ts:42'],
    ['[Report](</workspace/My Report.pdf>)', '/workspace/My Report.pdf'],
    ['[Report](file:///workspace/My%20Report.pdf)', 'file:///workspace/My%20Report.pdf'],
    ['[Source](C:\\workspace\\src\\main.ts:12)', 'C:/workspace/src/main.ts:12'],
    ['[Source](src/main.ts)', 'src/main.ts'],
  ]) {
    assert.ok(renderInline(input).includes(`data-cuppet-project-file="${path}"`), input);
  }
  assert.doesNotMatch(renderInline('[Unsafe](../outside.txt)'), /data-cuppet-project-file/);
});

test('bare web links are previewable without consuming trailing punctuation or code', () => {
  const html = renderInline('Visit https://example.com/page. (https://example.org/) and `https://code.example.com`.');
  assert.match(html, /href="https:\/\/example\.com\/page" data-cuppet-external/);
  assert.match(html, /href="https:\/\/example\.org\/" data-cuppet-external/);
  assert.match(html, /<code>https:\/\/code\.example\.com<\/code>/);
  assert.equal((html.match(/data-cuppet-external/g) || []).length, 2);
});
