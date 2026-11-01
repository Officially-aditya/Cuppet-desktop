import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const VERSION = 1;
const DEFAULTS = { version: VERSION, orchestratorEnabled: false, backgroundPaused: false, sessionModes: {}, sessionCompactions: {} };

export class CognitiveStateStore {
  #path; #state = structuredClone(DEFAULTS); #ready; #writes = Promise.resolve(); #writeID = 0;
  constructor(path) { this.#path = path; this.#ready = this.#load(); }
  async ready() { await this.#ready; }
  snapshot() { return structuredClone(this.#state); }
  mode(sessionID) { return this.#state.sessionModes[sessionID] === 'plan' ? 'plan' : 'build'; }
  async setMode(sessionID, mode) {
    await this.#ready; if (!['build', 'plan'].includes(mode)) throw new Error('mode must be build or plan');
    this.#state.sessionModes[sessionID] = mode; await this.#persist(); return { sessionId: sessionID, mode };
  }
  compaction(sessionID) { return structuredClone(this.#state.sessionCompactions[sessionID] ?? null); }
  async setCompaction(sessionID, { throughSequence, directive }) {
    await this.#ready;
    if (!Number.isSafeInteger(throughSequence) || throughSequence < 1 || typeof directive !== 'string' || !directive.trim() || directive.length > 65_536) throw new Error('invalid session compaction');
    this.#state.sessionCompactions = Object.fromEntries([...Object.entries(this.#state.sessionCompactions).filter(([id]) => id !== sessionID), [sessionID, { throughSequence, directive }]].slice(-512));
    await this.#persist();
  }
  async setOrchestrator(enabled) { await this.#ready; this.#state.orchestratorEnabled = Boolean(enabled); await this.#persist(); return { enabled: this.#state.orchestratorEnabled }; }
  async setBackgroundPaused(paused) { await this.#ready; this.#state.backgroundPaused = Boolean(paused); await this.#persist(); return { paused: this.#state.backgroundPaused }; }
  async forgetSession(sessionID) { await this.#ready; delete this.#state.sessionModes[sessionID]; delete this.#state.sessionCompactions[sessionID]; await this.#persist(); }
  async #load() {
    if (!this.#path) return;
    try {
      const parsed = JSON.parse(await readFile(this.#path, 'utf8'));
      this.#state = {
        version: VERSION,
        orchestratorEnabled: parsed?.orchestratorEnabled === true,
        backgroundPaused: parsed?.backgroundPaused === true,
        sessionCompactions: Object.fromEntries(Object.entries(parsed?.sessionCompactions && typeof parsed.sessionCompactions === 'object' && !Array.isArray(parsed.sessionCompactions) ? parsed.sessionCompactions : {}).filter(([, value]) => Number.isSafeInteger(value?.throughSequence) && value.throughSequence >= 1 && typeof value.directive === 'string' && value.directive.trim() && value.directive.length <= 65_536).slice(-512)),
        sessionModes: parsed?.sessionModes && typeof parsed.sessionModes === 'object' && !Array.isArray(parsed.sessionModes) ? Object.fromEntries(Object.entries(parsed.sessionModes).filter(([, mode]) => mode === 'build' || mode === 'plan').slice(-512)) : {},
      };
    } catch { this.#state = structuredClone(DEFAULTS); }
  }
  async #persist() {
    if (!this.#path) return;
    const snapshot = this.snapshot();
    this.#writes = this.#writes.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      const temp = `${this.#path}.${process.pid}.${this.#writeID++}.tmp`;
      await writeFile(temp, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
      await rename(temp, this.#path);
    });
    await this.#writes;
  }
}
