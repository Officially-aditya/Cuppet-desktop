import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';

const VERSION = 1;
const DEFAULT_PATH = join(process.env.CUPPET_DATA_DIR || join(homedir(), '.cuppet-desktop'), 'token-usage.json');
let singleton;

export class TokenUsageLedger {
  #path; #state = emptyState(); #ready; #queue = Promise.resolve();

  constructor(path = DEFAULT_PATH) {
    this.#path = path;
    this.#ready = this.#load();
  }

  async ready() { await this.#ready; }

  record({ providerID, modelID, usage, now = Date.now() } = {}) {
    const entry = {
      providerID: boundedLabel(providerID, 'unknown'),
      modelID: boundedLabel(modelID, 'unknown'),
      usage: normalizeTokenUsage(usage),
      now: finiteInteger(now) ?? Date.now(),
    };
    this.#queue = this.#queue.then(async () => {
      await this.#ready;
      applyEntry(this.#state, entry);
      await this.#persist();
    }).catch(() => undefined);
    return this.#queue;
  }

  async summary() {
    await this.#ready;
    await this.#queue;
    return publicSummary(this.#state);
  }

  async close() { await this.#queue; }

  async #load() {
    try {
      const parsed = JSON.parse(await readFile(this.#path, 'utf8'));
      this.#state = sanitizeState(parsed);
    } catch {
      this.#state = emptyState();
    }
  }

  async #persist() {
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true });
    const temporary = `${this.#path}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(this.#state, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.#path);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

export function recordProviderUsage(value) {
  singleton ??= new TokenUsageLedger();
  return singleton.record(value);
}

export function providerUsageSummary() {
  singleton ??= new TokenUsageLedger();
  return singleton.summary();
}

export function closeProviderUsageLedger() {
  return singleton?.close?.() ?? Promise.resolve();
}

export function normalizeTokenUsage(value) {
  const root = record(value);
  if (!Object.keys(root).length) return null;

  const inputTokens = firstNumber(root.inputTokens, root.input_tokens, root.prompt_tokens, root.promptTokenCount, root.prompt_token_count, root.totalInputTokens);
  const outputTokens = firstNumber(root.outputTokens, root.output_tokens, root.completion_tokens, root.candidatesTokenCount, root.candidates_token_count, root.totalOutputTokens);
  const directTotal = firstNumber(root.totalTokens, root.total_tokens, root.totalTokenCount, root.total_token_count);
  const cachedInputTokens = firstNumber(
    root.cachedInputTokens,
    root.cached_input_tokens,
    record(root.prompt_tokens_details).cached_tokens,
    record(root.input_tokens_details).cached_tokens,
    root.cache_read_input_tokens,
    root.cachedContentTokenCount,
    root.cached_content_token_count,
  );
  const reasoningTokens = firstNumber(
    root.reasoningTokens,
    root.reasoning_tokens,
    record(root.completion_tokens_details).reasoning_tokens,
    record(root.output_tokens_details).reasoning_tokens,
    root.thoughtsTokenCount,
    root.thoughts_token_count,
  );
  const totalTokens = directTotal ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);

  if ([inputTokens, outputTokens, totalTokens, cachedInputTokens, reasoningTokens].every((item) => item === null)) return null;
  return { inputTokens, outputTokens, totalTokens, cachedInputTokens, reasoningTokens };
}

function applyEntry(state, entry) {
  const key = `${entry.providerID}\u0000${entry.modelID}`;
  const model = state.byModel[key] ??= emptyBucket(entry.providerID, entry.modelID);
  state.requests += 1;
  model.requests += 1;
  state.lastRequestAt = entry.now;
  if (!state.firstRequestAt) state.firstRequestAt = entry.now;
  model.lastRequestAt = entry.now;
  if (!model.firstRequestAt) model.firstRequestAt = entry.now;

  if (!entry.usage) {
    state.unreportedRequests += 1;
    model.unreportedRequests += 1;
    return;
  }

  state.trackedRequests += 1;
  model.trackedRequests += 1;
  state.lastTrackedAt = entry.now;
  if (!state.firstTrackedAt) state.firstTrackedAt = entry.now;
  model.lastTrackedAt = entry.now;
  if (!model.firstTrackedAt) model.firstTrackedAt = entry.now;
  addUsage(state, entry.usage);
  addUsage(model, entry.usage);
}

function addUsage(target, usage) {
  if (usage.inputTokens !== null) target.inputTokens += usage.inputTokens;
  if (usage.outputTokens !== null) target.outputTokens += usage.outputTokens;
  if (usage.totalTokens !== null) target.totalTokens += usage.totalTokens;
  if (usage.cachedInputTokens !== null) target.cachedInputTokens += usage.cachedInputTokens;
  if (usage.reasoningTokens !== null) target.reasoningTokens += usage.reasoningTokens;
}

function publicSummary(state) {
  return {
    version: VERSION,
    requests: state.requests,
    trackedRequests: state.trackedRequests,
    unreportedRequests: state.unreportedRequests,
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    totalTokens: state.totalTokens,
    cachedInputTokens: state.cachedInputTokens,
    reasoningTokens: state.reasoningTokens,
    firstRequestAt: state.firstRequestAt,
    lastRequestAt: state.lastRequestAt,
    firstTrackedAt: state.firstTrackedAt,
    lastTrackedAt: state.lastTrackedAt,
    byModel: Object.values(state.byModel)
      .map((bucket) => ({ ...bucket }))
      .sort((a, b) => b.totalTokens - a.totalTokens || b.trackedRequests - a.trackedRequests || b.requests - a.requests)
      .slice(0, 64),
  };
}

function emptyState() {
  return { version: VERSION, ...emptyCounters(), firstRequestAt: null, lastRequestAt: null, firstTrackedAt: null, lastTrackedAt: null, byModel: {} };
}
function emptyBucket(providerID, modelID) {
  return { providerID, modelID, ...emptyCounters(), firstRequestAt: null, lastRequestAt: null, firstTrackedAt: null, lastTrackedAt: null };
}
function emptyCounters() {
  return { requests: 0, trackedRequests: 0, unreportedRequests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 };
}
function sanitizeState(value) {
  const source = record(value);
  const state = emptyState();
  for (const key of Object.keys(emptyCounters())) state[key] = finiteInteger(source[key]) ?? 0;
  for (const key of ['firstRequestAt', 'lastRequestAt', 'firstTrackedAt', 'lastTrackedAt']) state[key] = finiteInteger(source[key]);
  for (const [key, raw] of Object.entries(record(source.byModel))) {
    const item = record(raw);
    const providerID = boundedLabel(item.providerID, 'unknown');
    const modelID = boundedLabel(item.modelID, 'unknown');
    const bucket = emptyBucket(providerID, modelID);
    for (const counter of Object.keys(emptyCounters())) bucket[counter] = finiteInteger(item[counter]) ?? 0;
    for (const timestamp of ['firstRequestAt', 'lastRequestAt', 'firstTrackedAt', 'lastTrackedAt']) bucket[timestamp] = finiteInteger(item[timestamp]);
    state.byModel[`${providerID}\u0000${modelID}`] = bucket;
  }
  return state;
}
function boundedLabel(value, fallback) {
  const text = typeof value === 'string' ? value.trim().slice(0, 240) : '';
  return text || fallback;
}
function firstNumber(...values) {
  for (const value of values) {
    const parsed = finiteInteger(value);
    if (parsed !== null) return parsed;
  }
  return null;
}
function finiteInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : null;
}
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
