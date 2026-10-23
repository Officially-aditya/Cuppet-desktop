// Reopening a thought should reuse its parsed HTML. Bound the cache by source + HTML size.
export function createMarkdownCache(render: (source: string) => string, limitChars = 2_000_000) {
  const entries = new Map<string, string>();
  let size = 0;
  return (source: string): string => {
    const cached = entries.get(source);
    if (cached !== undefined) {
      entries.delete(source);
      entries.set(source, cached);
      return cached;
    }
    const html = render(source);
    const cost = source.length + html.length;
    if (cost <= limitChars / 4) {
      entries.set(source, html);
      size += cost;
      for (const [key, value] of entries) {
        if (size <= limitChars) break;
        entries.delete(key);
        size -= key.length + value.length;
      }
    }
    return html;
  };
}
