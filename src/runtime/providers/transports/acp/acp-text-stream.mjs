const TOKENIZED_WHITESPACE = 'tokenized-whitespace';
const MAX_PENDING_BOUNDARY = 64;

/**
 * Reassembles ACP text deltas without changing the default ACP semantics.
 *
 * Most ACP agents emit literal text deltas and therefore use the `verbatim`
 * path. A small number of agents frame token-sized chunks with whitespace or
 * blank lines around every chunk. For those agents the descriptor can opt in
 * to `tokenized-whitespace`, which removes only transport-level *boundary*
 * whitespace and reconstructs punctuation-aware spacing. Internal whitespace
 * and Markdown block structure remain untouched.
 */
export class AcpTextStreamAssembler {
  #framing;
  #text = '';
  #pendingBoundary = '';
  #lastWasBlock = false;

  constructor(policy = {}) {
    this.#framing = text(record(policy).framing) || 'verbatim';
  }

  get text() { return this.#text; }

  push(value) {
    const raw = typeof value === 'string' ? value : String(value ?? '');
    if (!raw) return '';
    if (this.#framing !== TOKENIZED_WHITESPACE) {
      this.#text += raw;
      return raw;
    }

    const normalized = raw.replace(/\r\n?/g, '\n');
    const leading = normalized.match(/^\s*/u)?.[0] ?? '';
    const trailing = normalized.match(/\s*$/u)?.[0] ?? '';
    const start = leading.length;
    const end = Math.max(start, normalized.length - trailing.length);
    const core = normalized.slice(start, end);

    if (!core) {
      this.#pendingBoundary = capBoundary(`${this.#pendingBoundary}${normalized}`);
      return '';
    }

    const boundary = `${this.#pendingBoundary}${leading}`;
    this.#pendingBoundary = capBoundary(trailing);
    const block = isBlockLike(core);
    const separator = this.#separator(boundary, core, block);
    const delta = `${separator}${core}`;
    this.#text += delta;
    this.#lastWasBlock = block;
    return delta;
  }

  flush() {
    // Trailing transport whitespace has no semantic value. Intentional block
    // boundaries are emitted when the next structured chunk arrives.
    this.#pendingBoundary = '';
    return '';
  }

  #separator(boundary, core, block) {
    if (!this.#text || !boundary) return '';
    const newlineCount = (boundary.match(/\n/g) ?? []).length;
    if ((block || this.#lastWasBlock) && newlineCount >= 2) {
      if (this.#text.endsWith('\n\n')) return '';
      if (this.#text.endsWith('\n')) return '\n';
      return '\n\n';
    }
    if ((block || this.#lastWasBlock) && newlineCount === 1) {
      return this.#text.endsWith('\n') ? '' : '\n';
    }
    if (/\s$/u.test(this.#text)) return '';
    if (startsWithoutLeadingSpace(core)) return '';
    if (endsWithOpeningPunctuation(this.#text)) return '';
    return ' ';
  }
}

export function normalizeAcpTextDeltas(chunks, policy = {}) {
  const assembler = new AcpTextStreamAssembler(policy);
  for (const chunk of Array.isArray(chunks) ? chunks : []) assembler.push(chunk);
  assembler.flush();
  return assembler.text;
}

function isBlockLike(value) {
  const core = String(value ?? '');
  if (core.includes('\n')) return true;
  if (/^(?:```|~~~|#{1,6}\s|>\s|[-*+]\s|\d+[.)]\s)/u.test(core)) return true;
  if (/^(?:\*\*[^*\n]+\*\*|__[^_\n]+__)$/u.test(core)) return true;
  if (core.length >= 48 && /\s/u.test(core) && /[.!?:]$/u.test(core)) return true;
  return false;
}

function startsWithoutLeadingSpace(value) {
  return /^(?:[,.;:!?%…\)\]\}]|['’])/u.test(value);
}

function endsWithOpeningPunctuation(value) {
  return /[\(\[\{]$/u.test(value);
}

function capBoundary(value) {
  const boundary = String(value ?? '');
  return boundary.length <= MAX_PENDING_BOUNDARY
    ? boundary
    : boundary.slice(boundary.length - MAX_PENDING_BOUNDARY);
}

function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
