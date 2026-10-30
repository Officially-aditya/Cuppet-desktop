// Opt-in benchmark scheduling; the normal idle enrichment policy is unchanged.
export class ActiveEnrichment {
  #enrich; #emit; #cancel; #delay; #timer; #started = false; #closed = false; #pending = ''; #runs = [];
  constructor({ enrich, emit = () => {}, cancel = () => {}, initialDelayMs = 60_000 }) {
    if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0) throw new Error('Invalid enrichment interval');
    this.#enrich = enrich; this.#emit = emit; this.#cancel = cancel; this.#delay = initialDelayMs;
  }
  start() {
    if (this.#started || this.#closed) return;
    this.#started = true;
    this.#emit({ type: 'background.dynamic.started', startedAt: Date.now(), initialDelayMs: this.#delay });
    this.#schedule();
  }
  takeContext() {
    const context = this.#pending;
    this.#pending = '';
    if (context) this.#emit({ type: 'background.dynamic.delivered', at: Date.now(), characters: context.length });
    return context;
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#cancel();
    this.#emit({ type: 'background.dynamic.finished', runs: this.#runs });
  }
  #schedule() {
    if (this.#closed) return;
    this.#timer = setTimeout(() => { void this.#run(); }, this.#delay);
    this.#timer.unref?.();
  }
  async #run() {
    const run = { round: this.#runs.length + 1, intervalMs: this.#delay, startedAt: Date.now() };
    this.#runs.push(run);
    this.#emit({ type: 'background.dynamic.running', ...run });
    try {
      const { context = '', ...result } = await this.#enrich();
      Object.assign(run, result, { finishedAt: Date.now() });
      if (!this.#closed && context) this.#pending = context;
    } catch (error) {
      Object.assign(run, { status: 'failed', error: String(error?.message ?? error), finishedAt: Date.now() });
    }
    this.#emit({ type: 'background.dynamic.completed', ...run });
    this.#delay *= 2;
    this.#schedule();
  }
}
