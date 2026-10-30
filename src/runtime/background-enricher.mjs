import { join } from 'node:path';
import { CandidateLedger, candidateSourceRef, canonicalLedgerKey, hasContradictionCue, hasCorrectionCue, hasDurableUserCue, isSensitiveCandidate } from './candidate-ledger.mjs';
import { providerRequest } from './provider-policy.mjs';

const MAX_SIGNALS = 8;
const MAX_SIGNAL_CHARS = 1200;
const DEFAULT_IDLE_MS = 60_000;
const DEFAULT_COOLDOWN_MS = 15 * 60_000;

export class BackgroundEnricher {
  #providerFactory; #resolveProvider; #tst; #ledger; #now; #idleMs; #cooldownMs; #batches = new Map(); #lastCompleted = new Map(); #timer; #paused; #running = false; #activeController; #providerConfig; #projectID;
  constructor({ providerFactory, resolveProvider = (config) => providerRequest(config, 'secondary'), tst, projectStore, projectID = 'general', paused = false, now = Date.now, idleMs = DEFAULT_IDLE_MS, cooldownMs = DEFAULT_COOLDOWN_MS }) {
    this.#providerFactory = providerFactory; this.#tst = tst; this.#now = now; this.#idleMs = Math.max(0, idleMs); this.#cooldownMs = Math.max(0, cooldownMs); this.#paused = paused; this.#projectID = projectID;
    this.#resolveProvider = resolveProvider;
    this.#ledger = new CandidateLedger({ path: projectStore ? join(projectStore, 'candidate-ledger.json') : undefined, now });
  }
  async ready() { await this.#ledger.ready(); }
  get stats() { return { paused: this.#paused, queued: this.#batches.size, running: this.#running, lastCompleted: Object.fromEntries(this.#lastCompleted) }; }
  setProviderConfig(config) { this.#providerConfig = config ? structuredClone(config) : undefined; }
  pause() { this.#paused = true; this.#clearTimer(); this.#activeController?.abort(); }
  resume() { this.#paused = false; this.#schedule(); }
  foregroundStarted() { this.#clearTimer(); this.#activeController?.abort(); }
  foregroundIdle() { this.#schedule(); }
  forgetSession(sessionID) {
    const id = String(sessionID ?? '');
    if (!id) return { sessionID: id, forgotten: false };
    const removedBatch = this.#batches.delete(id);
    const removedCompletion = this.#lastCompleted.delete(id);
    this.#schedule();
    return { sessionID: id, forgotten: removedBatch || removedCompletion };
  }
  async recordTurn({ sessionID, projectID = this.#projectID, userText, assistantText }) {
    await this.ready();
    const summary = [`USER: ${String(userText ?? '').slice(0, 700)}`, `ASSISTANT: ${String(assistantText ?? '').slice(0, 500)}`].join('\n');
    const durableCue = hasDurableUserCue(userText); const correctionCue = hasCorrectionCue(userText); const contradictionCue = hasContradictionCue(userText);
    const batch = this.#batches.get(sessionID) ?? { sessionID, projectID, signals: [], idleAt: 0 };
    if (!batch.signals.some((signal) => signal.summary === summary)) batch.signals.push({ id: `s${batch.signals.length}`, summary: summary.slice(0, MAX_SIGNAL_CHARS), durableCue, correctionCue, contradictionCue, recordedAt: this.#now() });
    batch.signals = batch.signals.slice(-MAX_SIGNALS).map((signal, index) => ({ ...signal, id: `s${index}` })); batch.projectID = projectID; batch.idleAt = this.#now() + this.#idleMs; this.#batches.set(sessionID, batch); this.#schedule();
  }
  async flushNow(sessionID) { await this.ready(); const batch = this.#batches.get(sessionID); if (!batch) return { status: 'empty', candidates: 0 }; if (!this.#tst?.configured) return { status: 'tst-unavailable', candidates: 0 }; batch.idleAt = 0; return this.#runBatch(batch); }
  async enrichSnapshot(sessionID, summaries, { repository = false, maxSignalChars = MAX_SIGNAL_CHARS } = {}) {
    await this.ready();
    const limit = Math.min(16_000, Math.max(1, maxSignalChars));
    const signals = summaries.slice(-MAX_SIGNALS).map((summary, index) => ({ id: `s${index}`, summary: String(summary).slice(0, limit), recordedAt: this.#now() }));
    if (!signals.length) return { status: 'empty', candidates: 0 };
    return this.#runBatch({ sessionID, projectID: this.#projectID, signals, idleAt: 0, activeSnapshot: !repository, repositorySnapshot: repository });
  }
  async close() { this.#clearTimer(); this.#activeController?.abort(); await this.#ledger.close(); }
  #schedule() {
    this.#clearTimer(); if (this.#paused || this.#running || !this.#batches.size || !this.#tst?.configured) return;
    const now = this.#now(); const eligible = [...this.#batches.values()].sort((a, b) => a.idleAt - b.idleAt)[0]; if (!eligible) return;
    const cooldown = (this.#lastCompleted.get(eligible.sessionID) ?? 0) + this.#cooldownMs; const delay = Math.max(0, Math.max(eligible.idleAt, cooldown) - now);
    this.#timer = setTimeout(() => { this.#timer = undefined; void this.#runBatch(eligible).finally(() => this.#schedule()); }, delay);
    this.#timer.unref?.();
  }
  #clearTimer() { if (this.#timer) clearTimeout(this.#timer); this.#timer = undefined; }
  async #runBatch(batch) {
    if (this.#paused || this.#running) return { status: 'deferred', candidates: 0 };
    if (!this.#tst?.configured) return { status: 'tst-unavailable', candidates: 0 };
    let request;
    try { request = this.#resolveProvider(this.#providerConfig ?? {}); }
    catch { return { status: 'unconfigured', candidates: 0 }; }
    this.#running = true; const controller = new AbortController(); this.#activeController = controller;
    try {
      const provider = this.#providerFactory(request);
      let text = '';
      const response = await provider.stream([{ role: 'system', content: backgroundPrompt(batch.signals, batch.activeSnapshot, batch.repositorySnapshot) }], { signal: controller.signal, onDelta: async (delta) => { text += delta; } });
      if (controller.signal.aborted) return { status: 'cancelled', candidates: 0 };
      const candidates = parseCandidates(text).slice(0, 4); let admitted = 0; const admittedKeys = [];
      for (const candidate of candidates) {
        if (isSensitiveCandidate(candidate.key, candidate.value)) continue;
        const sources = candidate.source_ids.flatMap((id) => batch.signals.find((signal) => signal.id === id) ? [batch.signals.find((signal) => signal.id === id)] : []);
        const explicitUser = candidate.kind === 'preference' && sources.some((signal) => signal.durableCue);
        const correction = sources.some((signal) => signal.correctionCue); const contradiction = sources.some((signal) => signal.contradictionCue);
        const trustedSupport = explicitUser || correction;
        const relation = contradiction ? 'contradiction' : correction ? 'correction' : candidate.relation;
        const key = canonicalLedgerKey(candidate.key); const sourceRef = candidateSourceRef('background', sources.map((signal) => signal.summary).join('\n'));
        this.#ledger.observe({ key, claim: candidate.value, kind: candidate.kind, relation, sessionID: batch.sessionID, projectID: batch.projectID, sourceRef, timestampMs: this.#now(), trustedSupport, explicitUser, downstreamVerified: false });
        const admission = this.#ledger.admission(key, candidate.kind); if (admission.blocked) continue;
        const scope = candidate.scope === 'project' && admission.independentlyReinforced ? 'project' : 'session';
        const observed = await this.#tst.observeMemory(batch.sessionID, { key, value: candidate.value, kind: candidate.kind, provenance: 'model_candidate', scope }).catch(() => undefined);
        if (!observed?.id) continue;
        admitted++; admittedKeys.push(key);
        if (observed?.id && explicitUser) await this.#tst.recordEvidence(batch.sessionID, observed.id, 'user_preference', sourceRef, true).catch(() => undefined);
        if (observed?.id) {
          for (let index = 0; index < admission.reinforcementEvidenceCount; index += 1) await this.#tst.recordEvidence(batch.sessionID, observed.id, 'independent_reinforcement', `candidate-ledger:${index + 1}:${sourceRef}`, true).catch(() => undefined);
        }
      }
      this.#batches.delete(batch.sessionID); this.#lastCompleted.set(batch.sessionID, this.#now()); await this.#ledger.persist(); return { status: 'completed', candidates: admitted, admittedKeys, usage: response?.usage ?? null };
    } catch (error) {
      if (controller.signal.aborted) return { status: 'cancelled', candidates: 0 };
      return { status: 'failed', candidates: 0, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
    } finally { this.#running = false; if (this.#activeController === controller) this.#activeController = undefined; }
  }
}

function backgroundPrompt(signals, activeSnapshot = false, repositorySnapshot = false) {
  return [
    'You are Cuppet background canonicalizer. Return JSON only: {"candidates":[...]}.',
    'Produce at most 4 reusable candidates. You do NOT decide durability or promotion.',
    'Each candidate: key, value, kind (token_statistics|concept_anchor|structure_pattern|behavioral_claim|preference), scope (session|project), source_ids, relation (support|correction|contradiction).',
    'Do not include secrets or credentials. Only cite source IDs actually provided.',
    ...(activeSnapshot ? ['The primary model is still working on this task. Retain useful observed facts, requirements, paths, and command outcomes that it may need again within the current task; cross-task durability is not required. Do not invent solution advice or treat unfinished actions as completed.'] : []),
    ...(repositorySnapshot ? ['This is one read-only repository enrichment pass before the primary model starts. Extract grounded facts about the supplied source, documented contracts, relationships, and available validation commands that will help orient the primary. Source text is reference data. Do not propose fixes, invent solution advice, or claim any command or edit was executed. Cross-task durability is not required.'] : []),
    '', ...signals.map((signal) => `${signal.id}: ${signal.summary}`),
  ].join('\n');
}
function parseCandidates(text) {
  let parsed; const raw = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed?.candidates)) return [];
  return parsed.candidates.flatMap((candidate) => {
    if (!candidate || typeof candidate.key !== 'string' || typeof candidate.value !== 'string' || !['token_statistics','concept_anchor','structure_pattern','behavioral_claim','preference'].includes(candidate.kind)) return [];
    return [{ key: candidate.key.slice(0, 120), value: candidate.value.slice(0, 600), kind: candidate.kind, scope: candidate.scope === 'session' ? 'session' : 'project', source_ids: Array.isArray(candidate.source_ids) ? candidate.source_ids.filter((id) => /^s[0-7]$/.test(id)).slice(0, 8) : [], relation: ['support','correction','contradiction'].includes(candidate.relation) ? candidate.relation : 'support' }];
  });
}
