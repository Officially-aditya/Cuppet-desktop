const DEFAULT_FIRST_ACTIVITY_WAIT_MS = 20_000;
const DEFAULT_TOOL_ACTIVITY_WAIT_MS = 20_000;
const DEFAULT_QUIET_PERIOD_MS = 1_500;
const DEFAULT_MAX_WAIT_MS = 120_000;

export class AcpTurnCompletionGate {
  #policy;
  #hinted = false;
  #promptResolved = false;
  #waiting = false;
  #pendingRequests = 0;
  #phaseTimer = null;
  #maxTimer = null;
  #resolveWait = null;

  constructor(descriptor) {
    this.#policy = completionPolicy(descriptor);
  }

  observeUpdate(value) {
    if (!this.#policy) return;
    const update = record(value);
    const mode = text(record(update.rawInput).mode).toLowerCase();
    if (mode && this.#policy.toolInputModes.has(mode)) this.#hinted = true;
    if (!this.#waiting || !this.#promptResolved) return;
    const kind = text(update.sessionUpdate);
    const status = text(update.status).toLowerCase();
    const toolStillWorking = kind === 'tool_call'
      || (kind === 'tool_call_update' && !isTerminalToolStatus(status));
    this.#armPhase(toolStillWorking ? this.#policy.toolActivityWaitMs : this.#policy.quietPeriodMs);
  }

  beginRequest() {
    if (!this.#policy || !this.#waiting || !this.#promptResolved) return () => {};
    this.#pendingRequests += 1;
    clearTimeout(this.#phaseTimer);
    this.#phaseTimer = null;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.#pendingRequests = Math.max(0, this.#pendingRequests - 1);
      if (this.#waiting) this.#armPhase(this.#policy.quietPeriodMs);
    };
  }

  async afterPrompt(prompt) {
    if (!this.#policy || !this.#hinted || text(prompt?.stopReason) !== 'end_turn') return;
    this.#promptResolved = true;
    this.#waiting = true;
    await new Promise((resolveWait) => {
      this.#resolveWait = resolveWait;
      this.#phaseTimer = setTimeout(() => this.#settle(), this.#policy.firstActivityWaitMs);
      this.#maxTimer = setTimeout(() => this.#settle(), this.#policy.maxWaitMs);
    });
  }

  cancel() {
    this.#settle();
  }

  #armPhase(delayMs) {
    clearTimeout(this.#phaseTimer);
    this.#phaseTimer = null;
    if (!this.#waiting || this.#pendingRequests > 0) return;
    this.#phaseTimer = setTimeout(() => this.#settle(), delayMs);
  }

  #settle() {
    if (!this.#waiting && !this.#resolveWait) return;
    this.#waiting = false;
    clearTimeout(this.#phaseTimer);
    clearTimeout(this.#maxTimer);
    this.#phaseTimer = null;
    this.#maxTimer = null;
    const resolveWait = this.#resolveWait;
    this.#resolveWait = null;
    resolveWait?.();
  }
}

function completionPolicy(descriptor) {
  const policy = record(record(descriptor?.turnCompletion).afterEndTurn);
  const toolInputModes = new Set((Array.isArray(policy.toolInputModes) ? policy.toolInputModes : [])
    .map((value) => text(value).toLowerCase())
    .filter(Boolean));
  if (!toolInputModes.size) return null;
  return Object.freeze({
    toolInputModes,
    firstActivityWaitMs: positiveMs(policy.firstActivityWaitMs, DEFAULT_FIRST_ACTIVITY_WAIT_MS),
    toolActivityWaitMs: positiveMs(policy.toolActivityWaitMs, DEFAULT_TOOL_ACTIVITY_WAIT_MS),
    quietPeriodMs: positiveMs(policy.quietPeriodMs, DEFAULT_QUIET_PERIOD_MS),
    maxWaitMs: positiveMs(policy.maxWaitMs, DEFAULT_MAX_WAIT_MS),
  });
}

function isTerminalToolStatus(value) {
  return value === 'completed' || value === 'success' || value === 'failed' || value === 'error' || value === 'cancelled' || value === 'canceled';
}
function positiveMs(value, fallback) { const number = Number(value); return Number.isFinite(number) && number > 0 ? number : fallback; }
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
