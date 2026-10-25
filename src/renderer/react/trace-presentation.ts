const TRACE_STATE_PREFIX = 'cuppet.desktop.trace.';

export function readTraceOpen(messageId: string, live: boolean): boolean {
  try {
    return localStorage.getItem(`${TRACE_STATE_PREFIX}${messageId}`) === (live ? 'live' : 'finished');
  } catch { return false; }
}

export function writeTraceOpen(messageId: string, live: boolean, open: boolean) {
  try {
    if (open) localStorage.setItem(`${TRACE_STATE_PREFIX}${messageId}`, live ? 'live' : 'finished');
    else localStorage.removeItem(`${TRACE_STATE_PREFIX}${messageId}`);
  } catch { /* Storage availability must not affect the disclosure. */ }
}

export function splitTraceText(previous: string, next: string) {
  const before = Array.from(previous);
  const after = Array.from(next);
  let start = 0;
  let end = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  while (end < before.length - start && end < after.length - start && before[before.length - end - 1] === after[after.length - end - 1]) end++;
  return {
    prefix: after.slice(0, start).join(''),
    removed: before.slice(start, before.length - end).join(''),
    added: after.slice(start, after.length - end).join(''),
    suffix: end ? after.slice(-end).join('') : '',
  };
}

export function observeTraceVisibility(node: HTMLElement) {
  const doc = node.ownerDocument;
  let visible = false;
  const update = () => { node.dataset.traceVisible = String(visible && doc.visibilityState === 'visible'); };
  const observer = new IntersectionObserver((entries) => {
    visible = entries.some((entry) => entry.isIntersecting);
    update();
  });
  update();
  observer.observe(node.querySelector('.trace-card-toggle') ?? node);
  doc.addEventListener('visibilitychange', update);
  return () => {
    observer.disconnect();
    doc.removeEventListener('visibilitychange', update);
    delete node.dataset.traceVisible;
  };
}
