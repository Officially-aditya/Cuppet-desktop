import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SCHEMA_VERSION = 1;
const MAX_SOURCE_BYTES = 1_000_000;
const MAX_CONTEXT_CHARS = 9_000;
const MAX_PHASE_TOOL_CHARS = 12_000;
const MAX_CACHED_PLANS = 128;

export class LosslessPlanStore {
  #directory;
  #plans = new Map();
  #writes = new Map();

  constructor(directory) { this.#directory = directory; }

  async capture({ sessionID, messageID, prompt, agent = 'build' }) {
    const sourcePrompt = String(prompt ?? '');
    if (Buffer.byteLength(sourcePrompt) > MAX_SOURCE_BYTES) return this.get(sessionID);
    const normalized = normalizePrompt(sourcePrompt);
    if (!shouldCapture(normalized, agent)) return this.get(sessionID);
    const existing = await this.get(sessionID);
    if (existing?.sources.some((source) => source.messageID === messageID)) {
      if (existing.lastAgent !== agent) await this.setAgent(sessionID, agent);
      return this.get(sessionID);
    }
    const phases = splitPhases(normalized, messageID, existing?.phases.length ?? 0);
    if (!phases.length) return existing;
    const now = Date.now();
    const source = { messageID, prompt: sourcePrompt, lineCount: lineCount(normalized), capturedAt: now };
    const plan = existing ? {
      ...existing,
      sources: [...existing.sources, source],
      phases: [...existing.phases, ...phases],
      updatedAt: now,
      lastAgent: agent,
    } : {
      schema: SCHEMA_VERSION,
      sessionID,
      sources: [source],
      phases,
      createdAt: now,
      updatedAt: now,
      lastAgent: agent,
    };
    await this.#save(plan);
    return structuredClone(plan);
  }

  async get(sessionID) {
    const cached = this.#plans.get(sessionID);
    if (cached) {
      this.#plans.delete(sessionID);
      this.#plans.set(sessionID, cached);
      return structuredClone(cached);
    }
    if (!this.#directory) return undefined;
    try {
      const decoded = decodePlan(JSON.parse(await readFile(this.#path(sessionID), 'utf8')), sessionID);
      if (!decoded) return undefined;
      this.#remember(decoded);
      return structuredClone(decoded);
    } catch { return undefined; }
  }

  async setAgent(sessionID, agent) {
    const plan = await this.get(sessionID);
    if (!plan || plan.lastAgent === agent) return plan;
    plan.lastAgent = agent;
    plan.updatedAt = Date.now();
    await this.#save(plan);
    return structuredClone(plan);
  }

  async toolResult(sessionID, request = {}) {
    const plan = await this.get(sessionID);
    if (!plan) return undefined;
    if (request.action === 'phase') {
      const phase = plan.phases.find((item) => item.id.toLowerCase() === String(request.phaseID ?? '').toLowerCase());
      if (!phase) return result(plan, `No phase named ${request.phaseID} exists.`, 0, false);
      const offset = Math.min(Math.max(0, Number(request.offset ?? 0)), phase.text.length);
      const limit = Math.min(Math.max(1, Number(request.limit ?? MAX_PHASE_TOOL_CHARS)), MAX_PHASE_TOOL_CHARS);
      const end = Math.min(phase.text.length, offset + limit);
      return result(plan, [
        `${phase.id} · ${phase.title} (lines ${phase.startLine}-${phase.endLine}; ${phase.status})`,
        '', phase.text.slice(offset, end),
        ...(end < phase.text.length ? ['', `Continue with offset=${end}.`] : []),
      ].join('\n'), 1, end < phase.text.length);
    }
    if (request.action === 'search') {
      const query = String(request.query ?? '').trim().toLowerCase();
      const all = plan.phases.filter((phase) => `${phase.title}\n${phase.text}`.toLowerCase().includes(query));
      const matches = all.slice(0, 12);
      return result(plan, matches.length ? matches.map((phase) => `- ${phase.id} [${phase.status}] ${phase.summary}`).join('\n') : `No phases match "${request.query ?? ''}".`, matches.length, all.length > matches.length);
    }
    const rendered = renderOverview(plan, Number.POSITIVE_INFINITY);
    return result(plan, rendered.text, plan.phases.length, rendered.truncated);
  }

  async #save(plan) {
    const snapshot = structuredClone(plan);
    this.#remember(snapshot);
    if (!this.#directory) return;
    const previous = this.#writes.get(snapshot.sessionID) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      await chmod(this.#directory, 0o700);
      const target = this.#path(snapshot.sessionID);
      const temporary = join(this.#directory, `.${createHash('sha256').update(snapshot.sessionID).digest('hex')}.${randomBytes(6).toString('hex')}.tmp`);
      await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
      await rename(temporary, target);
    });
    this.#writes.set(snapshot.sessionID, next);
    try { await next; } finally { if (this.#writes.get(snapshot.sessionID) === next) this.#writes.delete(snapshot.sessionID); }
  }

  #path(sessionID) { return join(this.#directory, `${createHash('sha256').update(sessionID).digest('hex')}.json`); }
  #remember(plan) {
    this.#plans.delete(plan.sessionID);
    this.#plans.set(plan.sessionID, structuredClone(plan));
    while (this.#plans.size > MAX_CACHED_PLANS) this.#plans.delete(this.#plans.keys().next().value);
  }
}

export function renderLosslessPlanContext(plan, agent = 'build') {
  const overview = renderOverview(plan, MAX_CONTEXT_CHARS);
  return [
    `<CUPPET_LOSSLESS_PLAN canonical="true" agent="${escapeAttribute(agent)}" phases="${plan.phases.length}">`,
    "The user's full implementation specification is preserved in Cuppet's private lossless plan store. The visible execution checklist is not the source of truth.",
    'Keep every unfinished phase represented. Retrieve exact phase requirements before declaring a phase complete.',
    '', overview.text,
    ...(overview.truncated ? ['', `Overview abbreviated; ${plan.phases.length} phases remain retrievable.`] : []),
    '</CUPPET_LOSSLESS_PLAN>',
  ].join('\n');
}

function result(plan, output, resultCount, truncated) {
  return { title: 'Cuppet lossless plan', output: `CUPPET LOSSLESS PLAN\n${output}`, metadata: { readOnly: true, source: 'lossless_plan', phaseCount: plan.phases.length, resultCount, truncated } };
}
function renderOverview(plan, limit) {
  const lines = [`CANONICAL IMPLEMENTATION PLAN (${plan.phases.length} phases)`];
  for (const phase of plan.phases) {
    const line = `- ${phase.id} [${phase.status}] ${phase.summary} (source lines ${phase.startLine}-${phase.endLine})`;
    if (Buffer.byteLength([...lines, line].join('\n')) > limit) return { text: lines.join('\n'), truncated: true };
    lines.push(line);
  }
  return { text: lines.join('\n'), truncated: false };
}
function shouldCapture(prompt, agent) {
  const lines = lineCount(prompt); const structure = phaseStarts(prompt.split('\n')).length;
  const action = /\b(implement|implementation|build|add|change|replace|migrate|refactor|fix|create|update|phase|milestone|requirement|acceptance)\b/i.test(prompt);
  if (String(agent).toLowerCase() === 'plan') return lines >= 24 || structure >= 3;
  return (lines >= 60 && (action || structure >= 5)) || (structure >= 5 && lines >= 32 && action);
}
function splitPhases(prompt, sourceMessageID, offset) {
  const lines = prompt.split('\n'); const starts = phaseStarts(lines);
  const boundaries = starts.length >= 2 && starts[0] > 0 ? [0, ...starts] : starts;
  const sections = boundaries.length >= 2 ? boundaries.map((start, i) => ({ start, end: (boundaries[i + 1] ?? lines.length) - 1 })) : paragraphSections(lines);
  return sections.flatMap((section, index) => {
    const text = lines.slice(section.start, section.end + 1).join('\n').trim(); if (!text) return [];
    const title = firstContentLine(text) || `Plan segment ${index + 1}`;
    return [{ id: `P${String(offset + index + 1).padStart(2, '0')}`, sourceMessageID, title: clipInline(title, 220), summary: clipInline(text, 360), text, startLine: section.start + 1, endLine: section.end + 1, status: 'pending' }];
  });
}
function phaseStarts(lines) {
  const headings = lines.flatMap((line, i) => /^\s{0,3}#{1,6}\s+\S/.test(line) ? [i] : []); if (headings.length >= 2) return headings;
  const numbered = topLevelStarts(lines, /^\s*(?:\d+[.)]|(?:phase|step|milestone|workstream)\s+\d*\s*[:.)-])\s*\S/i); if (numbered.length >= 3) return numbered;
  const bullets = topLevelStarts(lines, /^\s*[-*+]\s+\S/); return bullets.length >= 5 ? bullets : [];
}
function topLevelStarts(lines, pattern) {
  const matches = lines.flatMap((line, i) => pattern.test(line) ? [{ index: i, indent: (line.match(/^\s*/)?.[0] ?? '').replace(/\t/g, '  ').length }] : []);
  if (!matches.length) return []; const min = Math.min(...matches.map((m) => m.indent)); return matches.filter((m) => m.indent === min).map((m) => m.index);
}
function paragraphSections(lines) {
  const sections = []; let start; let nonempty = 0;
  for (let i = 0; i < lines.length; i++) { if (lines[i].trim()) { if (start === undefined) start = i; nonempty++; if (nonempty >= 12) { sections.push({ start, end: i }); start = undefined; nonempty = 0; } } else if (start !== undefined) { sections.push({ start, end: i - 1 }); start = undefined; nonempty = 0; } }
  if (start !== undefined) sections.push({ start, end: lines.length - 1 }); return sections;
}
function decodePlan(value, sessionID) {
  if (!value || value.schema !== SCHEMA_VERSION || value.sessionID !== sessionID || !Array.isArray(value.sources) || !Array.isArray(value.phases) || !value.sources.length || !value.phases.length) return undefined;
  return value;
}
function normalizePrompt(value) { return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim(); }
function lineCount(prompt) { return prompt.split('\n').filter((line) => line.trim()).length; }
function firstContentLine(value) { return value.split('\n').find((line) => line.trim())?.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|(?:phase|step|milestone|workstream)\s+\d*\s*[:.)-]\s*)/i, '').trim(); }
function clipInline(value, limit) { const normalized = value.replace(/\s+/g, ' ').trim(); return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`; }
function escapeAttribute(value) { return String(value).replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]); }
