import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import plaintext from 'highlight.js/lib/languages/plaintext';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

// The chat renderer. It escapes everything it does not generate itself, only emits http(s)/mailto/anchor links and
// project file references, and never emits inline styles or remote images (the CSP is style-src 'self', img-src
// 'self' data:). Highlighting output is escaped class-only spans, so it fits the same CSP.

const EXTERNAL_LINK = /^(https?:|mailto:)/i;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const CODE_FILE = /(?:^|\/)(?:Dockerfile|Makefile|Procfile|Gemfile|Rakefile|Cargo\.toml|go\.mod|go\.sum|package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|[^/]+\.(?:[cm]?[jt]sx?|json|mdx?|py|rs|go|java|kt|kts|swift|css|scss|sass|less|html?|vue|svelte|ya?ml|toml|sql|sh|bash|zsh|fish|c|h|cc|cpp|cxx|hpp|cs|rb|php|xml|gradle|properties|ini|conf|env|graphql|proto|txt|csv|tsv|pdf|docx?|xlsx?|pptx?|odt|rtf|png|jpe?g|webp|gif|svg|mp3|mp4|wav|mov|zip))(?::\d+(?::\d+)?(?:-\d+(?::\d+)?)?)?$/i;

const MAX_LIST_DEPTH = 8;
const HIGHLIGHT_LIMIT = 20_000;
const HIGHLIGHT_CACHE_SIZE = 200;

for (const [name, definition] of Object.entries({
  bash, c, cpp, csharp, css, diff, dockerfile, go, ini, java, javascript, json, kotlin, markdown, php, plaintext,
  powershell, python, ruby, rust, shell, sql, swift, typescript, xml, yaml,
})) hljs.registerLanguage(name, definition);

export function renderMarkdown(value: unknown) {
  const source = String(value ?? '').replace(/\r\n?/g, '\n');
  return renderBlocks(source.split('\n'), 0).join('\n');
}

function renderBlocks(lines: string[], depth: number): string[] {
  const out: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }

    const fence = openFence(line);
    if (fence) {
      const closer = new RegExp(`^\\s*${fence.marker[0] === '`' ? '`' : '~'}{${fence.marker.length},}\\s*$`);
      const body: string[] = [];
      index++;
      while (index < lines.length && !closer.test(lines[index])) body.push(lines[index++]);
      const closed = index < lines.length;
      if (closed) index++;
      out.push(renderCodeBlock(body.join('\n'), fence.info, closed));
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      index++;
      continue;
    }

    if (isThematicBreak(line)) { out.push('<hr>'); index++; continue; }

    if (isTableHeader(lines, index)) {
      const headers = tableCells(lines[index]);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) rows.push(tableCells(lines[index++]));
      out.push(`<div class="md-table-wrap"><table><thead><tr>${headers.map((cell) => `<th>${renderInline(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((_, cellIndex) => `<td>${renderInline(row[cellIndex] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      const values: string[] = [];
      while (index < lines.length) {
        const match = lines[index].match(/^\s*>\s?(.*)$/);
        if (!match) break;
        values.push(match[1]); index++;
      }
      out.push(`<blockquote>${depth < MAX_LIST_DEPTH ? renderBlocks(values, depth + 1).join('') : renderParagraphs(values)}</blockquote>`);
      continue;
    }

    if (listMarker(line) && depth < MAX_LIST_DEPTH) {
      const list = parseList(lines, index, depth);
      out.push(list.html);
      index = list.next;
      continue;
    }

    const paragraph = [line.trim()];
    index++;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines, index)) paragraph.push(lines[index++].trim());
    out.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
  }

  return out;
}

// --- fenced code ---------------------------------------------------------------------------------------------

/** An opening fence: three or more backticks or tildes. A backtick fence's info string may not contain a backtick. */
function openFence(line: string) {
  const match = line.match(/^\s*(`{3,}|~{3,})\s*([^\n]*)$/);
  if (!match) return null;
  if (match[1][0] === '`' && match[2].includes('`')) return null;
  return { marker: match[1], info: match[2].trim() };
}

function renderCodeBlock(code: string, info: string, closed: boolean) {
  const language = (info.split(/\s+/)[0] ?? '').replace(/[^A-Za-z0-9_+.#-]/g, '').slice(0, 40);
  // A fence that is still open is being streamed; highlighting it on every delta is wasted work, so it stays plain
  // until the closing fence arrives.
  const highlighted = closed ? highlightCode(code, language.toLowerCase()) : null;
  return `<div class="md-code-block"><div class="md-code-header"><span class="md-code-lang">${escapeHtml(language)}</span>`
    + '<button type="button" class="md-code-copy" data-cuppet-copy aria-label="Copy code">Copy</button></div>'
    + `<pre><code${language ? ` class="language-${escapeAttribute(language)}"` : ''}>${highlighted ?? escapeHtml(code)}</code></pre></div>`;
}

const highlightCache = new Map<string, string>();

function highlightCode(code: string, language: string): string | null {
  if (!language || code.length > HIGHLIGHT_LIMIT || !hljs.getLanguage(language)) return null;
  const key = `${language}\u0000${code}`;
  const cached = highlightCache.get(key);
  if (cached !== undefined) return cached;
  let html: string;
  try { html = hljs.highlight(code, { language, ignoreIllegals: true }).value; } catch { return null; }
  if (highlightCache.size >= HIGHLIGHT_CACHE_SIZE) highlightCache.delete(highlightCache.keys().next().value as string);
  highlightCache.set(key, html);
  return html;
}

// --- lists ---------------------------------------------------------------------------------------------------

type ListMarker = { indent: number; ordered: boolean; number: number; contentIndent: number; text: string };

function leadingWidth(line: string) {
  let width = 0;
  for (const char of line) {
    if (char === ' ') width++;
    else if (char === '\t') width += 4;
    else break;
  }
  return width;
}

/** Removes up to `columns` columns of leading whitespace (a tab counts as four). */
function stripIndent(line: string, columns: number) {
  const body = line.replace(/^[ \t]+/, (space) => space.replace(/\t/g, '    '));
  let remove = 0;
  while (remove < columns && body[remove] === ' ') remove++;
  return body.slice(remove);
}

function listMarker(line: string): ListMarker | null {
  const bullet = line.match(/^([ \t]*)([-+*])([ \t]+)(.*)$/);
  if (bullet) {
    const indent = leadingWidth(bullet[1]);
    return { indent, ordered: false, number: 0, contentIndent: indent + 1 + Math.min(bullet[3].length, 4), text: bullet[4] };
  }
  const ordered = line.match(/^([ \t]*)(\d{1,9})([.)])([ \t]+)(.*)$/);
  if (ordered) {
    const indent = leadingWidth(ordered[1]);
    return { indent, ordered: true, number: Number(ordered[2]), contentIndent: indent + ordered[2].length + 1 + Math.min(ordered[4].length, 4), text: ordered[5] };
  }
  return null;
}

type ListItem = { lines: string[]; contentIndent: number };

/**
 * Parses one list starting at `start`. Items own every following line that is indented under them (nested lists,
 * fenced code, further paragraphs) plus lazy paragraph continuations, and those lines are rendered recursively.
 * A sibling of a different kind, or a line that is not part of the item, ends the list; the next list then starts
 * at its own number, so a numbered list that is interrupted by a code block keeps counting.
 */
function parseList(lines: string[], start: number, depth: number) {
  const first = listMarker(lines[start]) as ListMarker;
  const items: ListItem[] = [];
  let current: ListItem | null = null;
  let index = start;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      let next = index + 1;
      while (next < lines.length && !lines[next].trim()) next++;
      if (!current || next >= lines.length) break;
      const nextMarker = listMarker(lines[next]);
      const nextIndent = leadingWidth(lines[next]);
      const sibling = nextMarker !== null && nextMarker.ordered === first.ordered && nextIndent - first.indent < 2 && nextIndent >= first.indent;
      if (!sibling && nextIndent <= first.indent) break;
      current.lines.push('');
      index = next;
      continue;
    }

    const marker = listMarker(line);
    const indent = leadingWidth(line);
    const delta = indent - first.indent;

    if (marker && delta < 2) {
      if (delta < 0 || marker.ordered !== first.ordered) break;
      current = { lines: [marker.text], contentIndent: marker.contentIndent };
      items.push(current);
      index++;
      continue;
    }

    if (!current) break;

    if (delta >= 1) {
      current.lines.push(stripIndent(line, Math.min(indent, current.contentIndent)));
      index++;
      continue;
    }

    // Not indented: a lazy continuation of the item's paragraph, unless it starts a new block.
    const previous = current.lines[current.lines.length - 1];
    if (previous !== undefined && previous.trim() && !startsBlock(lines, index)) {
      current.lines.push(line.trim());
      index++;
      continue;
    }
    break;
  }

  const tag = first.ordered ? 'ol' : 'ul';
  const startAttribute = first.ordered && first.number !== 1 ? ` start="${first.number}"` : '';
  const html = `<${tag}${startAttribute}>${items.map((item) => `<li>${renderListItem(item, depth)}</li>`).join('')}</${tag}>`;
  return { html, next: index };
}

function renderListItem(item: ListItem, depth: number) {
  const itemLines = [...item.lines];
  while (itemLines.length && !itemLines[itemLines.length - 1].trim()) itemLines.pop();
  const tight = !itemLines.some((line) => !line.trim());
  const blocks = renderBlocks(itemLines, depth + 1);
  // A tight item shows its text directly rather than wrapped in a paragraph.
  if (tight && blocks[0]?.startsWith('<p>') && blocks[0].endsWith('</p>')) blocks[0] = blocks[0].slice(3, -4);
  return blocks.join('');
}

// --- inline --------------------------------------------------------------------------------------------------

export function renderInline(value: unknown) {
  const placeholders: string[] = [];
  const reserve = (html: string) => `\u0000${placeholders.push(html) - 1}\u0000`;
  // NUL delimits placeholders, so text may not smuggle its own.
  let source = String(value ?? '').replace(/\u0000/g, '');

  source = source.replace(/`([^`\n]+)`/g, (_match, code) => {
    // Inline code that names a project file becomes a link at render time, so it is clickable in every chat,
    // including history, and needs no after-the-fact DOM patching.
    const path = inlineProjectPath(code);
    return reserve(path
      ? `<code data-cuppet-project-file="${escapeAttribute(path)}" role="link" tabindex="0">${escapeHtml(code)}</code>`
      : `<code>${escapeHtml(code)}</code>`);
  });

  source = replaceLinks(source, (image, label, href) => {
    if (image) return reserve(renderImage(label, href));
    const target = safeLink(href);
    if (!target) return escapeHtml(label);
    if (target.kind === 'external') {
      return reserve(`<a href="${escapeAttribute(target.href)}" data-cuppet-external="true" target="_blank" rel="noreferrer noopener">${escapeHtml(label)}</a>`);
    }
    if (target.kind === 'project') {
      return reserve(`<a href="#" data-cuppet-project-file="${escapeAttribute(target.path)}">${escapeHtml(label)}</a>`);
    }
    return reserve(`<a href="${escapeAttribute(target.href)}">${escapeHtml(label)}</a>`);
  });

  source = source.replace(/https?:\/\/[^\s<>"\u0000]{1,2048}/gi, (value) => {
    let href = value.replace(/[.,;!]+$/, '');
    while (href.endsWith(')') && (href.match(/\)/g)?.length || 0) > (href.match(/\(/g)?.length || 0)) href = href.slice(0, -1);
    return reserve(`<a href="${escapeAttribute(href)}" data-cuppet-external="true" target="_blank" rel="noreferrer noopener">${escapeHtml(href)}</a>`) + value.slice(href.length);
  });

  source = renderEmphasis(escapeHtml(source));

  return source.replace(/\u0000(\d+)\u0000/g, (_match, raw) => placeholders[Number(raw)] ?? '');
}

/**
 * Emphasis on already-escaped text. An asterisk run opens only after the start of the text, whitespace, an opening
 * bracket or quote, or a tag/entity, and an underscore run only where it is not inside a word, and both must hug
 * their content. That keeps snake_case names, 2*3*4 and wildcard paths literal.
 */
function renderEmphasis(escaped: string) {
  // Content is bounded so a long line full of unmatched markers cannot make matching quadratic.
  const OPENS = String.raw`(?<![^\s(\[{>;"'\u0000])`;      // start, whitespace, opening bracket/quote, or the end of a tag/entity
  const WORD_START = String.raw`(?=[\p{L}\p{N}_(\[<"'&\u0000])`; // a single marker must open before word-like text, not punctuation
  const STAR_END = String.raw`(?![\p{L}\p{N}*])`;
  const UNDERSCORE_END = String.raw`(?![\p{L}\p{N}_])`;
  const NOT_IN_WORD = String.raw`(?<![\p{L}\p{N}_])`;
  const rule = (pattern: string) => new RegExp(pattern, 'gu');
  return escaped
    .replace(rule(String.raw`${OPENS}\*\*\*(?![\s*])([^\n]{0,800}?[^\s*])\*\*\*${STAR_END}`), '<strong><em>$1</em></strong>')
    .replace(rule(String.raw`${OPENS}\*\*(?![\s*])([^\n]{0,800}?[^\s*])\*\*${STAR_END}`), '<strong>$1</strong>')
    .replace(rule(String.raw`${NOT_IN_WORD}__(?![\s_])([^\n]{0,800}?[^\s_])__${UNDERSCORE_END}`), '<strong>$1</strong>')
    .replace(rule(String.raw`${OPENS}\*${WORD_START}([^\n]{0,800}?[^\s*])\*${STAR_END}`), '<em>$1</em>')
    .replace(rule(String.raw`${NOT_IN_WORD}_${WORD_START}([^\n]{0,800}?[^\s_])_${UNDERSCORE_END}`), '<em>$1</em>')
    .replace(/~~(?!\s)([^~\n]{1,800}?)(?<!\s)~~/g, '<del>$1</del>');
}

/**
 * Replaces [label](destination) links and ![alt](destination) images. The destination may be <wrapped>, may contain
 * balanced parentheses (Wikipedia-style URLs), and may carry a "title". Anything that does not parse is left as text.
 */
function replaceLinks(source: string, render: (image: boolean, label: string, href: string) => string) {
  const opener = /(!?)\[([^\]\n]{0,500})\]\(/g;
  let out = '';
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source))) {
    const image = match[1] === '!';
    if (!image && !match[2]) continue;
    const destination = parseDestination(source, opener.lastIndex);
    if (!destination) continue;
    out += source.slice(last, match.index) + render(image, match[2], destination.href);
    last = destination.end;
    opener.lastIndex = destination.end;
  }
  return out + source.slice(last);
}

const DATA_DESTINATION = /[^\s)]+/y;
const DESTINATION = /(?:[^\s()\\]|\\.|\((?:[^\s()\\]|\\.)*\))+/y;

function parseDestination(source: string, from: number): { href: string; end: number } | null {
  let position = from;
  while (source[position] === ' ' || source[position] === '\t') position++;
  let href = '';

  if (source[position] === '<') {
    const close = source.indexOf('>', position + 1);
    if (close === -1) return null;
    href = source.slice(position + 1, close);
    if (/[\n<]/.test(href)) return null;
    position = close + 1;
  } else if (source.startsWith('data:image/', position)) {
    // Inline images are the one destination allowed to be long (base64); it has no spaces or parentheses.
    DATA_DESTINATION.lastIndex = position;
    const match = DATA_DESTINATION.exec(source);
    if (!match) return null;
    href = match[0];
    position += href.length;
  } else {
    // Non-space characters, backslash escapes and one level of balanced parentheses, capped so that a run of
    // unmatched openers stays cheap.
    DESTINATION.lastIndex = 0;
    const match = DESTINATION.exec(source.slice(position, position + 2100));
    if (!match || match[0].length > 2048) return null;
    href = match[0];
    position += href.length;
  }
  if (!href) return null;

  while (source[position] === ' ' || source[position] === '\t') position++;
  const quote = source[position];
  if (quote === '"' || quote === "'") {
    const close = source.indexOf(quote, position + 1);
    if (close === -1 || source.slice(position, close).includes('\n')) return null;
    position = close + 1;
    while (source[position] === ' ' || source[position] === '\t') position++;
  }
  return source[position] === ')' ? { href, end: position + 1 } : null;
}

function renderImage(alt: string, href: string) {
  const src = safeImageSrc(href);
  if (!src) return escapeHtml(alt);
  if (/^data:/i.test(src)) {
    return `<span class="md-image-wrap"><img src="${escapeAttribute(src)}" alt="${escapeAttribute(alt)}" class="markdown-image" loading="lazy" /></span>`;
  }
  if (/^https?:/i.test(src)) {
    // The CSP only allows data: images, so a remote <img> would render as a broken icon. Offer a link instead.
    return `<a href="${escapeAttribute(src)}" data-cuppet-external="true" target="_blank" rel="noreferrer noopener" class="md-remote-image" title="Remote images are not loaded here. Open the link to view it.">${escapeHtml(alt.trim() || 'Image')}</a>`;
  }
  return escapeHtml(alt);
}

/** The project-relative path an inline code span names, or '' when it is not a plain file reference. */
export function inlineProjectPath(value: unknown) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.length > 1024 || /:\/\/|[|;&<>`$]/.test(raw)) return '';
  if (/\s/.test(raw) && !/^(?:[/\\]|[A-Za-z]:[/\\])/.test(raw)) return '';
  const path = raw.replace(/^\.\//, '').replaceAll('\\', '/');
  if (!path || path === '..' || path.startsWith('../') || path.includes('/../') || !CODE_FILE.test(path)) return '';
  return path;
}

function startsBlock(lines: string[], index: number) {
  const line = lines[index] ?? '';
  return openFence(line) !== null
    || /^\s{0,3}#{1,6}\s+/.test(line)
    || /^\s*>/.test(line)
    || listMarker(line) !== null
    || isThematicBreak(line)
    || isTableHeader(lines, index);
}

/** Three or more of the same - * or _, optionally spaced out (---, * * *, ___). */
function isThematicBreak(line: string) {
  return /^\s{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line);
}

function isTableHeader(lines: string[], index: number) {
  if (!lines[index]?.includes('|') || !lines[index + 1]?.includes('|')) return false;
  const cells = tableCells(lines[index + 1]);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, '')));
}

/** Splits a table row on unescaped pipes that are not inside a code span. */
function tableCells(line: string) {
  const text = String(line).trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  const cells: string[] = [];
  let cell = '';
  let inCode = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\\' && text[i + 1] === '|') { cell += '|'; i++; continue; }
    if (char === '`' && (inCode || text.indexOf('`', i + 1) !== -1)) inCode = !inCode;
    if (char === '|' && !inCode) { cells.push(cell.trim()); cell = ''; continue; }
    cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

function renderParagraphs(lines: string[]) {
  return lines.join('\n').split(/\n\s*\n/).map((part) => `<p>${renderInline(part.replace(/\n/g, ' '))}</p>`).join('');
}

function safeLink(value: unknown): { kind: 'external' | 'anchor'; href: string } | { kind: 'project'; path: string } | null {
  const href = String(value ?? '').trim().slice(0, 2048);
  if (!href || href.includes('\0')) return null;
  if (EXTERNAL_LINK.test(href)) return { kind: 'external', href };
  if (href.startsWith('#')) return { kind: 'anchor', href };
  if (/^file:\/\//i.test(href)) return { kind: 'project', path: href };
  if (href.startsWith('//') || (URL_SCHEME.test(href) && !/^[A-Za-z]:[\\/]/.test(href))) return null;

  const path = href.replace(/^\.\//, '').replaceAll('\\', '/');
  if (!path || path === '..' || path.startsWith('../') || path.includes('/../')) return null;
  if (!path.includes('/') && !/^[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+$/.test(path)) return null;
  return { kind: 'project', path: path.slice(0, 1024) };
}

function safeImageSrc(value: unknown): string | null {
  const src = String(value ?? '').trim().slice(0, 20 * 1024 * 1024);
  if (!src || src.includes('\0')) return null;
  if (/^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/i.test(src)) return src;
  if (EXTERNAL_LINK.test(src)) return src.slice(0, 2048);
  return null;
}

export function escapeHtml(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char));
}

function escapeAttribute(value: unknown) { return escapeHtml(value).replace(/`/g, '&#96;'); }
