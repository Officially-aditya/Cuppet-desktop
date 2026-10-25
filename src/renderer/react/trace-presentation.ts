const TRACE_STATE_PREFIX = 'cuppet.desktop.trace.';

export function readTraceOpen(messageId: string, live: boolean, defaultOpen = live): boolean {
  try {
    const saved = localStorage.getItem(`${TRACE_STATE_PREFIX}${messageId}`);
    const phase = live ? 'live' : 'finished';
    if (saved === phase) return true;
    if (saved === `${phase}:closed`) return false;
  } catch { /* Use the normal disclosure default if storage is unavailable. */ }
  return defaultOpen;
}

export function writeTraceOpen(messageId: string, live: boolean, open: boolean) {
  try {
    const phase = live ? 'live' : 'finished';
    localStorage.setItem(`${TRACE_STATE_PREFIX}${messageId}`, open ? phase : `${phase}:closed`);
  } catch { /* Storage availability must not affect the disclosure. */ }
}
