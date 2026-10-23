// Input is sanitized HTML from markdown.ts. Append a balanced fragment when the
// existing markup is unchanged, preserving links, code spans and selected text.
export function appendMarkdownText(node: HTMLElement, previous: string, next: string): boolean {
  const closing = previous.match(/(?:<\/[a-z][a-z0-9]*>)+$/i)?.[0];
  if (!closing) return false;
  const tags = [...closing.matchAll(/<\/([a-z][a-z0-9]*)>/gi)];
  for (let from = tags.length - 1; from >= 0; from--) {
    const suffix = tags.slice(from).map((match) => match[0]).join('');
    if (!next.endsWith(suffix)) continue;
    const prefix = previous.slice(0, -suffix.length);
    if (!next.startsWith(prefix)) continue;
    const addition = next.slice(prefix.length, -suffix.length);
    if (!addition || !balanced(addition)) continue;

    let target = node.lastElementChild;
    for (let index = tags.length - 1; index >= from; index--) {
      if (!target || target.tagName.toLowerCase() !== tags[index][1].toLowerCase()) { target = null; break; }
      if (index > from) target = target.lastElementChild;
    }
    if (!target) continue;
    const decoded = node.ownerDocument.createElement('template');
    decoded.innerHTML = addition;
    const first = decoded.content.firstChild;
    const last = target.lastChild;
    if (first?.nodeType === 3 && last?.nodeType === 3) {
      (last as Text).appendData(first.textContent ?? '');
      first.remove();
    }
    target.appendChild(decoded.content);
    return true;
  }
  return false;
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
