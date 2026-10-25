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
  { active: 'Designing', done: 'Designed' },
  { active: 'Engineering', done: 'Engineered' },
  { active: 'Constructing', done: 'Constructed' },
  { active: 'Fabricating', done: 'Fabricated' },
  { active: 'Prototyping', done: 'Prototyped' },
  { active: 'Sketching', done: 'Sketched' },
  { active: 'Mapping', done: 'Mapped' },
  { active: 'Planning', done: 'Planned' },
  { active: 'Surveying', done: 'Surveyed' },
  { active: 'Measuring', done: 'Measured' },
  { active: 'Modeling', done: 'Modeled' },
  { active: 'Shaping', done: 'Shaped' },
  { active: 'Carving', done: 'Carved' },
  { active: 'Chiseling', done: 'Chiseled' },
  { active: 'Hammering', done: 'Hammered' },
  { active: 'Welding', done: 'Welded' },
  { active: 'Soldering', done: 'Soldered' },
  { active: 'Casting', done: 'Cast' },
  { active: 'Molding', done: 'Molded' },
  { active: 'Lathing', done: 'Lathed' },
  { active: 'Joining', done: 'Joined' },
  { active: 'Fitting', done: 'Fitted' },
  { active: 'Riveting', done: 'Riveted' },
  { active: 'Reinforcing', done: 'Reinforced' },
  { active: 'Bracing', done: 'Braced' },
  { active: 'Aligning', done: 'Aligned' },
  { active: 'Balancing', done: 'Balanced' },
  { active: 'Calibrating', done: 'Calibrated' },
  { active: 'Refining', done: 'Refined' },
  { active: 'Polishing', done: 'Polished' },
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
