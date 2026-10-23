import assert from 'node:assert/strict';
import test from 'node:test';
import { renderInline, renderMarkdown, renderMarkdownBlocks } from '../src/renderer/react/markdown.ts';

const strip = (html) => html.replace(/<[^>]+>/g, '');

test('block rendering preserves complete lists, fenced code and escaping for progressive reasoning', () => {
  const source = '# Plan\n\n- first\n  - nested\n- second\n\n```ts\nconst value = "<tag>";\n```\n\n<script>bad()</script>';
  const blocks = renderMarkdownBlocks(source);
  assert.equal(blocks.length, 4);
  assert.match(blocks[1], /^<ul>.*<ul>.*<\/ul>.*<\/ul>$/);
  assert.match(blocks[2], /^<div class="md-code-block">/);
  assert.doesNotMatch(blocks.join('\n'), /<script>/);
  assert.equal(blocks.join('\n'), renderMarkdown(source));
});

test('UI-01: bullet lists nest to any depth the model writes', () => {
  assert.equal(renderMarkdown('- a\n  - b\n    - c\n- d'), '<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>');
});

test('UI-01: a nested list under a numbered item works with two, three or four spaces', () => {
  for (const indent of ['  ', '   ', '    ']) {
    assert.equal(renderMarkdown(`1. Run\n${indent}- sub\n2. Done`), '<ol><li>Run<ul><li>sub</li></ul></li><li>Done</li></ol>', JSON.stringify(indent));
  }
});

test('UI-01: fenced code and a second paragraph can live inside a list item', () => {
  const html = renderMarkdown('1. Install\n\n   Then run:\n\n   ```bash\n   npm i\n   ```\n2. Next');
  assert.match(html, /<ol><li><p>Install<\/p><p>Then run:<\/p><div class="md-code-block">/);
  assert.match(html, /<code class="language-bash">npm i<\/code>/);
  assert.match(html, /<\/div><\/li><li>Next<\/li><\/ol>/);
});

test('UI-02: a numbered list interrupted by flush-left code blocks keeps counting', () => {
  const html = renderMarkdown('1. one\n```\nx\n```\n2. two\n```\ny\n```\n3. three');
  assert.match(html, /<ol><li>one<\/li><\/ol>/);
  assert.match(html, /<ol start="2"><li>two<\/li><\/ol>/);
  assert.match(html, /<ol start="3"><li>three<\/li><\/ol>/);
});

test('UI-02: lists that start at 1 carry no start attribute', () => {
  assert.equal(renderMarkdown('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>');
  assert.match(renderMarkdown('5) a\n6) b'), /<ol start="5">/);
});

test('UI-03: identifiers, arithmetic and wildcard paths are not emphasis', () => {
  for (const text of ['retry_backoff_ms', 'snake_case_name here', '2*3*4', 'src/*/utils/*.js', '*.ts and *.js files', 'a * b * c', 'call foo_bar_baz() now']) {
    const html = renderInline(text);
    assert.doesNotMatch(html, /<em>|<strong>/, text);
    assert.equal(strip(html), text);
  }
});

test('UI-03: real emphasis still works', () => {
  assert.equal(renderInline('**bold** and *it* and _it_ and __bold__'), '<strong>bold</strong> and <em>it</em> and <em>it</em> and <strong>bold</strong>');
  assert.equal(renderInline('***both***'), '<strong><em>both</em></strong>');
  assert.equal(renderInline('**.env** and **C++**'), '<strong>.env</strong> and <strong>C++</strong>');
  assert.equal(renderInline('~~gone~~'), '<del>gone</del>');
  assert.equal(renderInline('(*note*) and "_quoted_"'), '(<em>note</em>) and &quot;<em>quoted</em>&quot;');
  assert.equal(renderInline('**bold _inner_ text**'), '<strong>bold <em>inner</em> text</strong>');
});

test('UI-03: emphasis markers inside code spans and link labels are left alone', () => {
  assert.match(renderInline('`a_b_c` and `*x*`'), /<code>a_b_c<\/code> and <code>\*x\*<\/code>/);
  assert.match(renderInline('[my_link_name](https://example.com)'), />my_link_name<\/a>/);
});

test('UI-04: a four-backtick fence can contain a three-backtick fence', () => {
  const html = renderMarkdown('````md\n```js\nlet a = 1;\n```\n````\nafter');
  assert.equal((html.match(/class="md-code-block"/g) || []).length, 1);
  assert.match(html, /```js/);
  assert.match(html, /<p>after<\/p>/);
});

test('UI-04: tilde fences work, and a short run does not close a longer fence', () => {
  assert.match(renderMarkdown('~~~sh\necho hi\n~~~'), /<code class="language-sh">/);
  const html = renderMarkdown('````\n```\ninside\n```\n````');
  assert.equal((html.match(/class="md-code-block"/g) || []).length, 1);
  assert.match(html, /inside/);
});

test('UI-04: only the first word of the info string is the language', () => {
  const html = renderMarkdown('```ts title="a.ts" {1,3}\nlet a = 1;\n```');
  assert.match(html, /class="language-ts"/);
  assert.match(html, /<span class="md-code-lang">ts<\/span>/);
  assert.doesNotMatch(html, /title/);
});

test('UI-04: inline triple backticks on one line are not a fence', () => {
  assert.doesNotMatch(renderMarkdown('```not a fence```'), /md-code-block/);
});

test('UI-04: link destinations may contain balanced parentheses, angle brackets and titles', () => {
  assert.match(renderInline('[w](https://en.wikipedia.org/wiki/Foo_(bar))'), /href="https:\/\/en\.wikipedia\.org\/wiki\/Foo_\(bar\)"[^>]*>w<\/a>/);
  assert.match(renderInline('[t](https://a.example/x "a title")'), /href="https:\/\/a\.example\/x"[^>]*>t<\/a>/);
  assert.match(renderInline('[s](<https://a.example/a b>)'), /href="https:\/\/a\.example\/a b"[^>]*>s<\/a>/);
  const trailing = renderInline('(see [z](https://z.example)).');
  assert.match(trailing, /\(see <a [^>]*>z<\/a>\)\./);
});

test('UI-04: unterminated or malformed links stay as text', () => {
  assert.equal(strip(renderInline('[a](https://x.example')), '[a](https://x.example');
  assert.doesNotMatch(renderInline('[](https://x.example)'), /<a [^>]*>\s*<\/a>/);
});

test('UI-04: three or more spaced rule characters make a horizontal rule', () => {
  for (const rule of ['---', '* * *', '___', '- - -', '*****']) assert.equal(renderMarkdown(rule), '<hr>', rule);
  assert.match(renderMarkdown('* a\n* b'), /<ul>/);
});

test('UI-05: remote images are links, data images are kept, mailto images are dropped', () => {
  assert.doesNotMatch(renderInline('![x](https://example.com/a.png)'), /<img/);
  assert.match(renderInline('![x](data:image/png;base64,AAAA "title")'), /<img src="data:image\/png;base64,AAAA"/);
  assert.equal(renderInline('![x](mailto:a@b.example)'), 'x');
});

test('UI-06: code blocks have a language label, a copy button and highlighted tokens', () => {
  const html = renderMarkdown('```ts\nconst a: number = 1;\n```');
  assert.match(html, /<div class="md-code-block"><div class="md-code-header"><span class="md-code-lang">ts<\/span><button type="button" class="md-code-copy" data-cuppet-copy aria-label="Copy code">Copy<\/button><\/div><pre>/);
  assert.match(html, /<span class="hljs-keyword">const<\/span>/);
});

test('UI-06: highlighting aliases resolve and unknown languages fall back to plain escaped text', () => {
  assert.match(renderMarkdown('```js\nconst a = 1;\n```'), /hljs-keyword/);
  assert.match(renderMarkdown('```sh\necho "$HOME"\n```'), /hljs-/);
  assert.match(renderMarkdown('```py\ndef f(): pass\n```'), /hljs-keyword/);
  const plain = renderMarkdown('```nonsense\n<b>x</b> & y\n```');
  assert.match(plain, /<code class="language-nonsense">&lt;b&gt;x&lt;\/b&gt; &amp; y<\/code>/);
  assert.doesNotMatch(renderMarkdown('```\nconst a = 1;\n```'), /hljs-/);
});

test('UI-06: a fence that is still streaming stays plain until it closes', () => {
  assert.doesNotMatch(renderMarkdown('```ts\nconst a: number = 1;'), /hljs-/);
  assert.match(renderMarkdown('```ts\nconst a: number = 1;\n```'), /hljs-keyword/);
});

test('UI-06: highlighted output never lets code become markup', () => {
  const html = renderMarkdown('```html\n<script>alert(1)</script><img src=x onerror=alert(1)>\n```');
  assert.doesNotMatch(html, /<script|<img/);
  assert.match(html, /&lt;/);
});

test('model text can never inject markup or attributes', () => {
  const hostile = [
    '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '**<b onmouseover=1>x</b>**', '[<img src=x onerror=1>](https://a.example)',
    '[x](javascript:alert(1))', '[x](JaVaScRiPt:alert(1))', '[x]( javascript:alert(1))', '![x](javascript:alert(1))', '[x](vbscript:msgbox)',
    '[x](data:text/html;base64,PHNjcmlwdD4=)', '[a](//evil.example)', '[x](https://a.example" onclick="alert(1))', 'https://a.example/"onclick="x',
  ];
  for (const text of hostile) {
    const html = renderMarkdown(text);
    assert.doesNotMatch(html, /<script|<img[^>]*\son\w+=|<[a-z]+[^>]*\son\w+=["']|href="javascript|href="data:|href="vbscript|href="\/\//i, text);
  }
});

test('attribute values from model text stay inside their quotes', () => {
  const html = renderInline('![a" onerror="alert(1)](data:image/png;base64,AAAA)');
  assert.match(html, /alt="a&quot; onerror=&quot;alert\(1\)"/);
  assert.match(renderInline('[x](https://a.example/?q=1&r="2")'), /href="https:\/\/a\.example\/\?q=1&amp;r=&quot;2&quot;"/);
});

test('NUL characters in text cannot reference the renderer\'s own placeholders', () => {
  const html = renderInline('`secret` \u00000\u0000');
  assert.equal(strip(html).includes('secret'), true);
  assert.equal((html.match(/secret/g) || []).length, 1, 'the code span is rendered once, not duplicated by a forged placeholder');
});

test('tables honour escaped pipes and pipes inside code spans', () => {
  const html = renderMarkdown('| a | b |\n|---|---|\n| `x|y` | p \\| q |');
  assert.match(html, /<td><code>x\|y<\/code><\/td><td>p \| q<\/td>/);
});

test('block quotes can hold lists and code', () => {
  const html = renderMarkdown('> note\n> - item\n>\n> ```js\n> let a;\n> ```');
  assert.match(html, /<blockquote><p>note<\/p><ul><li>item<\/li><\/ul><div class="md-code-block">/);
});

test('tight list items are not wrapped in paragraphs but loose ones are', () => {
  assert.equal(renderMarkdown('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
  assert.match(renderMarkdown('- a\n\n  more\n- b'), /<li><p>a<\/p><p>more<\/p><\/li>/);
  assert.equal(renderMarkdown('- one\ncontinues\n- two'), '<ul><li>one continues</li><li>two</li></ul>');
});

test('different list kinds are separate lists', () => {
  assert.equal(renderMarkdown('1. a\n- b'), '<ol><li>a</li></ol>\n<ul><li>b</li></ul>');
});

test('very deep nesting is bounded instead of recursing without limit', () => {
  const deep = Array.from({ length: 40 }, (_, level) => `${'  '.repeat(level)}- level ${level}`).join('\n');
  assert.doesNotThrow(() => renderMarkdown(deep));
  assert.match(renderMarkdown(deep), /level 39/);
});

test('adversarial input stays fast: unmatched markers, brackets, link openers and long URLs', () => {
  const cases = {
    stars: '*a '.repeat(70_000),
    strong: '**a '.repeat(50_000),
    underscores: '_a '.repeat(70_000),
    brackets: '['.repeat(100_000),
    openers: '[a]('.repeat(50_000),
    images: '![a]('.repeat(40_000),
    url: `https://a.example/${')'.repeat(100_000)}`,
    ticks: '`'.repeat(100_000),
  };
  for (const [name, text] of Object.entries(cases)) {
    const started = performance.now();
    renderMarkdown(text);
    assert.ok(performance.now() - started < 3000, `${name} took ${Math.round(performance.now() - started)}ms`);
  }
});

test('a large inline image is rendered without scanning it character by character', () => {
  const started = performance.now();
  const html = renderMarkdown(`![d](data:image/png;base64,${'A'.repeat(4_000_000)})`);
  assert.match(html, /<img /);
  assert.ok(performance.now() - started < 3000);
});
