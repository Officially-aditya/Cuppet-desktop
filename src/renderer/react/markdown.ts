const EXTERNAL_LINK = /^(https?:|mailto:)/i;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const CODE_FILE = /(?:^|\/)(?:Dockerfile|Makefile|Procfile|Gemfile|Rakefile|Cargo\.toml|go\.mod|go\.sum|package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|[^/]+\.(?:[cm]?[jt]sx?|json|mdx?|py|rs|go|java|kt|kts|swift|css|scss|sass|less|html?|vue|svelte|ya?ml|toml|sql|sh|bash|zsh|fish|c|h|cc|cpp|cxx|hpp|cs|rb|php|xml|gradle|properties|ini|conf|env|graphql|proto|txt|csv|tsv|pdf|docx?|xlsx?|pptx?|odt|rtf|png|jpe?g|webp|gif|svg|mp3|mp4|wav|mov|zip))(?::\d+(?::\d+)?(?:-\d+(?::\d+)?)?)?$/i;

export function renderMarkdown(value: unknown) {
  const source = String(value ?? '').replace(/\r\n?/g, '\n');
  const lines = source.split('\n');
  const out: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }

    const fence = line.match(/^\s*```([^`]*)$/);
    if (fence) {
      const body: string[] = [];
      index++;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) body.push(lines[index++]);
      if (index < lines.length) index++;
      const language = fence[1].trim().replace(/[^A-Za-z0-9_+.-]/g, '').slice(0, 40);
      out.push(`<pre><code${language ? ` class="language-${escapeAttribute(language)}"` : ''}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      index++;
      continue;
    }

    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) { out.push('<hr>'); index++; continue; }

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
      out.push(`<blockquote>${renderParagraphs(values)}</blockquote>`);
      continue;
    }

    const unordered = line.match(/^\s*[-+*]\s+(.+)$/);
    if (unordered) {
      const items: string[] = [];
      while (index < lines.length) {
        const match = lines[index].match(/^\s*[-+*]\s+(.+)$/);
        if (!match) break;
        items.push(match[1]); index++;
      }
      out.push(`<ul>${items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</ul>`);
      continue;
    }

    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ordered) {
      const items: string[] = [];
      while (index < lines.length) {
        const match = lines[index].match(/^\s*\d+[.)]\s+(.+)$/);
        if (!match) break;
        items.push(match[1]); index++;
      }
      out.push(`<ol>${items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</ol>`);
      continue;
    }

    const paragraph = [line.trim()];
    index++;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines, index)) paragraph.push(lines[index++].trim());
    out.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
  }

  return out.join('\n');
}

export function renderInline(value: unknown) {
  const placeholders: string[] = [];
  const reserve = (html: string) => `\u0000${placeholders.push(html) - 1}\u0000`;
  let source = String(value ?? '');

  source = source.replace(/`([^`\n]+)`/g, (_match, code) => {
    // Inline code that names a project file becomes a link at render time, so it is clickable in every chat,
    // including history, and needs no after-the-fact DOM patching.
    const path = inlineProjectPath(code);
    return reserve(path
      ? `<code data-cuppet-project-file="${escapeAttribute(path)}" role="link" tabindex="0">${escapeHtml(code)}</code>`
      : `<code>${escapeHtml(code)}</code>`);
  });
  source = source.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (_match, alt, href) => {
    const target = safeImageSrc(href);
    if (!target) return escapeHtml(alt || '');
    return reserve(`<span class="md-image-wrap"><img src="${escapeAttribute(target)}" alt="${escapeAttribute(alt || '')}" class="markdown-image" loading="lazy" /></span>`);
  });
  source = source.replace(/\[([^\]\n]+)\]\(\s*(<[^>\n]+>|[^)\s]+)\s*\)/g, (_match, label, href) => {
    if (href.startsWith('<')) href = href.slice(1, -1);
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

  source = source.replace(/https?:\/\/[^\s<>"\u0000]+/gi, (value) => {
    let href = value.replace(/[.,;!]+$/, '');
    while (href.endsWith(')') && (href.match(/\)/g)?.length || 0) > (href.match(/\(/g)?.length || 0)) href = href.slice(0, -1);
    return reserve(`<a href="${escapeAttribute(href)}" data-cuppet-external="true" target="_blank" rel="noreferrer noopener">${escapeHtml(href)}</a>`) + value.slice(href.length);
  });

  source = escapeHtml(source)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  return source.replace(/\u0000(\d+)\u0000/g, (_match, raw) => placeholders[Number(raw)] ?? '');
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
  return /^\s*```/.test(line)
    || /^\s{0,3}#{1,6}\s+/.test(line)
    || /^\s*>/.test(line)
    || /^\s*[-+*]\s+/.test(line)
    || /^\s*\d+[.)]\s+/.test(line)
    || /^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)
    || isTableHeader(lines, index);
}

function isTableHeader(lines: string[], index: number) {
  if (!lines[index]?.includes('|') || !lines[index + 1]?.includes('|')) return false;
  const cells = tableCells(lines[index + 1]);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, '')));
}

function tableCells(line: string) {
  return String(line).trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
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
