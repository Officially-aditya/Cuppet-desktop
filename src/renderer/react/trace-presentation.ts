const TRACE_STATE_PREFIX = 'cuppet.desktop.trace.';

const WORK_WORDS = [
  { active: 'Forging', done: 'Forged' },
  { active: 'Smithering', done: 'Smithered' },
  { active: 'Blueprinting', done: 'Blueprinted' },
  { active: 'Drafting', done: 'Drafted' },
  { active: 'Framing', done: 'Framed' },
  { active: 'Scaffolding', done: 'Scaffolded' },
  { active: 'Sculpting', done: 'Sculpted' },
  { active: 'Assembling', done: 'Assembled' },
  { active: 'Crafting', done: 'Crafted' },
  { active: 'Building', done: 'Built' },
] as const;

export function workWords(id: string) {
  // Message and activity IDs supply the variation, so words survive streaming and reloads.
  let hash = 2166136261;
  for (const character of id) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619);
  return WORK_WORDS[(hash >>> 0) % WORK_WORDS.length];
}

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
