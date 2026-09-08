import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const SCHEMA_VERSION = 1;
const DEFAULT_MAX_ENTRIES = 512;
const DEFAULT_WEAK_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export class CandidateLedger {
  #path; #now; #maxEntries; #weakTtlMs; #entries = new Map(); #ready; #persisting = Promise.resolve(); #writeID = 0;
  constructor({ path, now = Date.now, maxEntries = DEFAULT_MAX_ENTRIES, weakTtlMs = DEFAULT_WEAK_TTL_MS } = {}) {
    this.#path = path; this.#now = now; this.#maxEntries = Math.max(1, Math.floor(maxEntries)); this.#weakTtlMs = Math.max(0, Math.floor(weakTtlMs)); this.#ready = this.#restore();
  }
  async ready() { await this.#ready; }
  get size() { return this.#entries.size; }
  entry(key, kind) { const value = this.#entries.get(ledgerKey(key, kind)); return value ? structuredClone(value) : undefined; }
  observe(observation) {
    const key = bounded(observation.key, 120); const claim = bounded(observation.claim, 600); const id = ledgerKey(key, observation.kind);
    const entry = this.#entries.get(id) ?? { key, claim, kind: observation.kind, support_count: 0, explicit_user_count: 0, correction_count: 0, session_count: 0, project_count: 0, contradiction_count: 0, downstream_verification_count: 0, last_seen: observation.timestampMs, source_refs: [], session_refs: [], project_refs: [] };
    entry.key = key; entry.claim = claim; entry.last_seen = Math.max(entry.last_seen, Math.max(0, Math.floor(observation.timestampMs)));
    if (observation.trustedSupport) {
      if (observation.relation === 'contradiction') entry.contradiction_count++;
      else {
        entry.support_count++;
        if (observation.relation === 'correction') { entry.correction_count++; entry.contradiction_count = Math.max(0, entry.contradiction_count - 1); }
        if (observation.explicitUser) entry.explicit_user_count++;
        if (observation.downstreamVerified) entry.downstream_verification_count++;
      }
      pushUnique(entry.session_refs, identityRef(observation.sessionID), 16);
      pushUnique(entry.project_refs, identityRef(observation.projectID), 16);
    }
    entry.session_count = entry.session_refs.length; entry.project_count = entry.project_refs.length;
    if (observation.sourceRef) pushUnique(entry.source_refs, bounded(observation.sourceRef, 160), 8);
    this.#entries.set(id, entry); this.#enforceBound(); return structuredClone(entry);
  }
  admission(key, kind) {
    const entry = this.#entries.get(ledgerKey(key, kind));
    if (!entry) return { blocked: false, explicitUserPreference: false, independentlyReinforced: false, reinforcementEvidenceCount: 0, score: 0.5, sourceRefs: [] };
    const blocked = entry.contradiction_count > 0; const reinforced = !blocked && hasIndependentReinforcement(entry);
    return { blocked, explicitUserPreference: !blocked && kind === 'preference' && entry.explicit_user_count > 0, independentlyReinforced: reinforced, reinforcementEvidenceCount: reinforced ? reinforcementEvidenceCount(entry) : 0, score: admissionScore(entry, this.#now()), sourceRefs: [...entry.source_refs] };
  }
  decay(nowMs = this.#now()) {
    const before = this.#entries.size;
    for (const [id, entry] of this.#entries) {
      const weak = entry.explicit_user_count === 0 && entry.correction_count === 0 && entry.downstream_verification_count === 0 && !hasIndependentReinforcement(entry);
      if (weak && Math.max(0, nowMs - entry.last_seen) > this.#weakTtlMs) this.#entries.delete(id);
    }
    return before - this.#entries.size;
  }
  compact() { const before = this.#entries.size; this.decay(); this.#enforceBound(); return before - this.#entries.size; }
  async persist() {
    await this.#ready; if (!this.#path) return; this.compact();
    const snapshot = { version: SCHEMA_VERSION, entries: [...this.#entries.values()].map((entry) => structuredClone(entry)) };
    this.#persisting = this.#persisting.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 }); const temp = `${this.#path}.${process.pid}.${this.#writeID++}.tmp`;
      await writeFile(temp, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 }); await rename(temp, this.#path);
    });
    await this.#persisting;
  }
  async close() { await this.persist(); }
  async #restore() {
    if (!this.#path) return;
    try {
      const parsed = JSON.parse(await readFile(this.#path, 'utf8')); if (parsed.version !== SCHEMA_VERSION || !Array.isArray(parsed.entries)) return;
      for (const raw of parsed.entries.slice(-this.#maxEntries * 2)) { const entry = normalizeEntry(raw); if (entry) this.#entries.set(ledgerKey(entry.key, entry.kind), entry); }
      this.compact();
    } catch { this.#entries.clear(); }
  }
  #enforceBound() {
    while (this.#entries.size > this.#maxEntries) {
      const victim = [...this.#entries.entries()].sort((a, b) => retentionStrength(a[1]) - retentionStrength(b[1]) || a[1].last_seen - b[1].last_seen || a[0].localeCompare(b[0]))[0]?.[0];
      if (!victim) break; this.#entries.delete(victim);
    }
  }
}

export function canonicalLedgerKey(value) { return String(value).trim().toLowerCase().replace(/[\s\-_]+/g, ' ').replace(/[^\p{L}\p{N} .:/]/gu, '').replace(/\s+/g, ' '); }
export function hasDurableUserCue(value) { const text = String(value).trim(); return /\b(?:i\s+(?:prefer|want|like)|i(?:'d| would)\s+rather|always\s+use|never\s+(?:use|do)|do\s+not\s+(?:use|do)|don't\s+(?:use|do)|remember\s+(?:that|this)|from\s+now\s+on|this\s+(?:repo|project)\s+should|should\s+(?:always\s+)?use|must\s+(?:always\s+)?use|i\s+said|already\s+told\s+you)\b/i.test(text) || /^(?:please\s+)?(?:use|avoid|keep|prefer|never\s+use|don't\s+use|do\s+not\s+use)\b/i.test(text); }
export function hasCorrectionCue(value) { return /\b(?:i\s+said|already\s+told\s+you|don't\s+do\s+that\s+again|do\s+not\s+do\s+that\s+again|as\s+i\s+said)\b/i.test(String(value)); }
export function hasContradictionCue(value) { return /\b(?:never\s+(?:use|do)|don't\s+(?:use|do)|do\s+not\s+(?:use|do)|stop\s+(?:using|doing)|no\s+longer\s+(?:use|want|prefer)|instead\s+(?:use|do)|not\s+.+\s+anymore)\b/i.test(String(value)); }
export function isSensitiveCandidate(key, value) {
  const text = `${String(key).toLowerCase()} ${String(value).toLowerCase()}`;
  if (['api_key','api-key','password','private key','authorization: bearer','refresh_token','access_token','client_secret'].some((marker) => text.includes(marker))) return true;
  if (String(value).includes('-----BEGIN ')) return true;
  if (String(value).split(/\s+/).some((part) => (/^(?:sk-|ghp_|glpat-|xoxb-|AIza|AKIA|ASIA)/.test(part) && part.length > 16))) return true;
  return String(value).startsWith('eyJ') && (String(value).match(/\./g)?.length ?? 0) >= 2 && String(value).length > 40;
}
export function candidateSourceRef(kind, value) { return `${kind}:${createHash('sha256').update(`${kind}\0${value}`).digest('hex').slice(0, 16)}`; }

function ledgerKey(key, kind) { return `${kind}\0${canonicalLedgerKey(key)}`; }
function identityRef(value) { return createHash('sha256').update(String(value)).digest('hex').slice(0, 24); }
function bounded(value, limit) { return String(value ?? '').trim().slice(0, limit); }
function pushUnique(values, value, limit) { if (!value || values.includes(value)) return; values.push(value); while (values.length > limit) values.shift(); }
function hasIndependentReinforcement(entry) { return entry.session_count >= 2 || entry.project_count >= 2 || entry.correction_count > 0 || entry.support_count >= 3; }
function reinforcementEvidenceCount(entry) { let count = 0; if (entry.session_count >= 2) count += 2; if (entry.project_count >= 2) count++; if (entry.support_count >= 3) count++; if (entry.correction_count > 0) count += 2; return Math.min(4, count); }
function admissionScore(entry, now) { let score = 0.5; if (entry.explicit_user_count) score += 0.1; if (entry.session_count >= 2) score += 0.2; if (entry.project_count >= 2) score += 0.1; if (entry.support_count >= 3) score += 0.1; if (entry.correction_count) score += 0.2; if (entry.downstream_verification_count) score += 0.1; if (entry.contradiction_count) score = Math.min(score, 0.79); const ageDays = Math.max(0, now - entry.last_seen) / 86400000; if (ageDays > 30 && !entry.explicit_user_count && !entry.downstream_verification_count && !hasIndependentReinforcement(entry)) score *= 0.98 ** (ageDays - 30); return Math.max(0, Math.min(1, score)); }
function retentionStrength(entry) { return entry.explicit_user_count * 100 + entry.downstream_verification_count * 50 + entry.correction_count * 30 + Math.max(0, entry.session_count - 1) * 20 + Math.max(0, entry.project_count - 1) * 20 + entry.support_count - Math.min(entry.contradiction_count, entry.support_count); }
function normalizeEntry(value) { if (!value || typeof value !== 'object' || typeof value.key !== 'string' || typeof value.claim !== 'string' || !['token_statistics','concept_anchor','structure_pattern','behavioral_claim','preference'].includes(value.kind)) return undefined; return { ...value, source_refs: Array.isArray(value.source_refs) ? value.source_refs.slice(-8) : [], session_refs: Array.isArray(value.session_refs) ? value.session_refs.slice(-16) : [], project_refs: Array.isArray(value.project_refs) ? value.project_refs.slice(-16) : [] }; }
