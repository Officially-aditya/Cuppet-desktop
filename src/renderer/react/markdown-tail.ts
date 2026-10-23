import { escapeHtml } from './markdown';

// Input is sanitized HTML from markdown.ts. Append a balanced fragment when the
// existing markup is unchanged, preserving links, code spans and selected text.
export function updateMarkdownTail(node: HTMLElement, previous: string, next: string) {
  if (appendMarkdownText(node, previous, next)) return;
  const parsed = node.ownerDocument.createElement('template');
  parsed.innerHTML = next;
  reconcileChildren(node, parsed.content);
}

export function appendMarkdownText(node: HTMLElement, previous: string, next: string): boolean {
  const closing = previous.match(/(?:<\/[a-z][a-z0-9]*>)+$/i)?.[0];
  if (!closing) return false;
  const tags = [...closing.matchAll(/<\/([a-z][a-z0-9]*)>/gi)];
  for (let from = tags.length - 1; from >= 0; from--) {
    const suffix = tags.slice(from).map((match) => match[0]).join('');
    if (!next.endsWith(suffix)) continue;
    let target = node.lastElementChild;
    for (let index = tags.length - 1; index >= from; index--) {
      if (!target || target.tagName.toLowerCase() !== tags[index][1].toLowerCase()) { target = null; break; }
      if (index > from) target = target.lastElementChild;
    }
    if (!target) continue;
    let prefix = previous.slice(0, -suffix.length);
    const last = target.lastChild;
    let replaceText = false;
    if (!next.startsWith(prefix)) {
      if (last?.nodeType !== 3) continue;
      const encoded = escapeHtml(last.textContent);
      if (!encoded || !prefix.endsWith(encoded)) continue;
      prefix = prefix.slice(0, -encoded.length);
      if (!next.startsWith(prefix)) continue;
      replaceText = true;
    }
    const addition = next.slice(prefix.length, -suffix.length);
    if (!addition || !balanced(addition)) continue;
    const decoded = node.ownerDocument.createElement('template');
    decoded.innerHTML = addition;
    const first = decoded.content.firstChild;
    if (first?.nodeType === 3 && last?.nodeType === 3) {
      if (replaceText) replaceTextSuffix(last as Text, first.textContent ?? '');
      else (last as Text).appendData(first.textContent ?? '');
      first.remove();
    } else if (replaceText) last!.remove();
    target.appendChild(decoded.content);
    return true;
  }
  return false;
}

// Closing a streamed emphasis marker or code span changes existing HTML. Keep the
// equal prefix in that case too, rather than rebuilding the whole paragraph.
function reconcileChildren(node: Node, parsed: Node) {
  let current = node.firstChild;
  for (const next of Array.from(parsed.childNodes)) {
    const following = current?.nextSibling ?? null;
    if (current?.isEqualNode(next)) { current = following; continue; }
    if (current?.nodeType === 3 && next.nodeType === 3) {
      replaceTextSuffix(current as Text, next.nodeValue ?? '');
    } else if (current instanceof Element && next instanceof Element && current.tagName === next.tagName
      && current.attributes.length === next.attributes.length
      && Array.from(current.attributes).every(attribute => next.getAttribute(attribute.name) === attribute.value)) {
      reconcileChildren(current, next);
    } else if (current) node.replaceChild(next, current);
    else node.appendChild(next);
    current = following;
  }
  while (current) {
    const following = current.nextSibling;
    node.removeChild(current);
    current = following;
  }
}

function replaceTextSuffix(node: Text, after: string) {
  const before = node.data;
  let prefix = 0;
  while (prefix < before.length && before[prefix] === after[prefix]) prefix++;
  node.replaceData(prefix, before.length - prefix, after.slice(prefix));
}

function balanced(html: string) {
  const stack: string[] = [];
  for (const match of html.matchAll(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi)) {
    const tag = match[1].toLowerCase();
    if (match[0][1] === '/') { if (stack.pop() !== tag) return false; }
    else if (!['br', 'hr', 'img'].includes(tag)) stack.push(tag);
  }
  return stack.length === 0;
}
