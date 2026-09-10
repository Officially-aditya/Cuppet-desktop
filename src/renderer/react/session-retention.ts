const TRACE_PREFIX = 'cuppet.desktop.trace.';
const LAST_SESSION_KEY = 'cuppet.desktop.last-session';

export function installSessionRetentionCleanup() {
  return window.cuppet.onEvent((event) => {
    if (event?.type !== 'session.purged') return;
    for (const messageId of Array.isArray(event.messageIds) ? event.messageIds : []) {
      const id = String(messageId ?? '').slice(0, 256);
      if (id) localStorage.removeItem(`${TRACE_PREFIX}${id}`);
    }
    if (event.sessionId && localStorage.getItem(LAST_SESSION_KEY) === String(event.sessionId)) {
      localStorage.removeItem(LAST_SESSION_KEY);
    }
  });
}
