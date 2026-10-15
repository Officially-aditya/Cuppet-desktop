import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const stores = new Map();
const profileVariables = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'GEMINI_HOME', 'GROK_HOME', 'COPILOT_HOME', 'CLAUDE_CONFIG_DIR', 'VIBE_HOME', 'KIRO_HOME', 'OPENCODE_CONFIG_DIR'];

export function providerSessionScope(providerID, command, environment) {
  const profile = Object.fromEntries(profileVariables.map(key => [key, environment[key] || '']));
  const credentials = Object.fromEntries(Object.keys(environment).sort().filter(key => !key.startsWith('CUPPET_') && /(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_BASE_URL|_ENDPOINT|_CONFIG_CONTENT|_CONFIG_FILE)$/.test(key)).map(key => [key, environment[key]]));
  return createHash('sha256').update(JSON.stringify([
    providerID, basename(command).replace(/\.(exe|cmd|bat)$/i, ''), profile, credentials,
  ])).digest('hex');
}

export function providerSessionStore() {
  const path = process.env.CUPPET_DATA_DIR ? join(process.env.CUPPET_DATA_DIR, 'provider-sessions.json') : null;
  if (!stores.has(path)) stores.set(path, new ProviderSessionStore({ path }));
  return stores.get(path);
}

export class ProviderSessionStore {
  #path;
  #records = new Map();
  #active = new Set();

  constructor({ path = null } = {}) {
    this.#path = path;
    if (path && existsSync(path)) {
      const data = JSON.parse(readFileSync(path, 'utf8'));
      if (data.schemaVersion !== 1 || !Array.isArray(data.sessions)) throw new Error('Cuppet provider session ownership file is invalid.');
      for (const record of data.sessions) {
        if (record?.id && record.scope && record.providerID && typeof record.sessionId === 'string') this.#records.set(record.id, record);
      }
    }
  }

  track({ providerID, scope, sessionId, cwd }) {
    if (!sessionId || sessionId.length > 1024 || sessionId.includes('\0')) throw new Error('Provider returned an invalid session ID.');
    const record = { id: randomUUID(), providerID, scope, sessionId, cwd, createdAt: Date.now(), ownerPid: process.pid, released: false };
    this.#records.set(record.id, record);
    this.#active.add(record.id);
    try { this.#save(); } catch (error) { error.ownedProviderSession = record; throw error; }
    return record;
  }

  release(record) {
    if (!this.#records.has(record.id)) return;
    this.#active.delete(record.id);
    record.released = true;
    this.#save();
  }

  complete(record) {
    this.#active.delete(record.id);
    this.#records.delete(record.id);
    this.#save();
  }

  defer(record, error) {
    if (!this.#records.has(record.id)) return;
    record.lastError = String(error?.code || error?.name || 'Cleanup failed').slice(0, 100);
    this.#save();
  }

  pending(scope, limit = 12) {
    return [...this.#records.values()].filter(record => {
      if ((scope && record.scope !== scope) || this.#active.has(record.id)) return false;
      if (!record.released) {
        try { process.kill(record.ownerPid, 0); return false; } catch (error) { if (error.code !== 'ESRCH') return false; }
      }
      return true;
    }).slice(0, limit);
  }

  snapshot() { return [...this.#records.values()].map(record => ({ ...record })); }

  #save() {
    if (!this.#path) return;
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, sessions: [...this.#records.values()] }), { mode: 0o600 });
    renameSync(temporary, this.#path);
  }
}
