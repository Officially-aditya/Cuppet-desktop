import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { credentialStorageStatus } from './credential-storage.mjs';
import {
  MCP_LIMITS,
  isMcpEnvName,
  isMcpServerId,
  mcpServerSlug,
  normalizeMcpServerInput,
  parseMcpServersJson,
} from '../shared/mcp-config.mjs';

const FILE_VERSION = 1;

/**
 * User-configured MCP servers, persisted in the Electron userData directory.
 *
 * Environment values (MCP servers are usually given API tokens this way) are treated like provider API keys:
 * encrypted with the OS credential vault, never returned to the renderer, and never written in plaintext. If the
 * vault is unavailable, saving environment values is refused instead of silently falling back to plaintext.
 *
 * `safeStorage` is injected (main.mjs passes Electron's) so this module has no Electron dependency.
 */
export class McpSettingsStore {
  #path;
  #safeStorage;
  #storageStatus;
  /** @type {Array<{ id: string, name: string, command: string, args: string[], enabled: boolean, env: Record<string, string> }>} */
  #servers = [];

  constructor(path, { safeStorage, credentialStorageStatusImpl = credentialStorageStatus } = {}) {
    this.#path = path;
    this.#safeStorage = safeStorage;
    this.#storageStatus = credentialStorageStatusImpl;
  }

  async load() {
    let parsed;
    try { parsed = JSON.parse(await readFile(this.#path, 'utf8')); } catch { this.#servers = []; return; }
    const stored = Array.isArray(parsed?.servers) ? parsed.servers : [];
    const servers = [];
    for (const item of stored.slice(0, MCP_LIMITS.servers)) {
      try {
        const base = normalizeMcpServerInput({ ...item, env: {}, enabled: item?.enabled === true });
        const env = Object.create(null);
        // Values on disk are ciphertext. Keep well-formed names with string values and drop anything else.
        if (item?.env && typeof item.env === 'object' && !Array.isArray(item.env)) {
          for (const [key, value] of Object.entries(item.env)) if (isMcpEnvName(key) && typeof value === 'string') env[key] = value;
        }
        const id = isMcpServerId(item?.id) && !servers.some((server) => server.id === item.id) ? item.id : this.#uniqueId(base.name, servers);
        servers.push({ id, name: base.name, command: base.command, args: base.args, enabled: base.enabled, env });
      } catch { /* A hand-edited or corrupt entry must not take the others down with it. */ }
    }
    this.#servers = servers;
  }

  rendererValue() {
    const storage = this.#storageStatus(this.#safeStorage);
    return {
      servers: this.#servers.map((server) => ({
        id: server.id,
        name: server.name,
        command: server.command,
        args: [...server.args],
        enabled: server.enabled,
        // Names only. The renderer is never given a stored value, not even a masked one.
        envKeys: Object.keys(server.env),
      })),
      limit: MCP_LIMITS.servers,
      encryptionAvailable: storage.available === true,
      ...(storage.available ? {} : { encryptionUnavailableReason: storage.reason ?? 'OS credential encryption is unavailable' }),
    };
  }

  /** Full configuration for the runtime process, with environment values decrypted. Memory-only on the other side. */
  runtimeValue() {
    return {
      servers: this.#servers.map((server) => {
        const decrypted = this.#decryptEnv(server.env);
        return {
          id: server.id,
          name: server.name,
          command: server.command,
          args: [...server.args],
          enabled: server.enabled,
          env: decrypted.env,
          ...(decrypted.failed ? { blocked: 'Saved environment values could not be decrypted. Open Settings → MCP, edit this server and enter them again.' } : {}),
        };
      }),
    };
  }

  async save(input) {
    const source = input && typeof input === 'object' ? input : {};
    const id = typeof source.id === 'string' && source.id ? source.id : '';
    const existing = id ? this.#servers.find((server) => server.id === id) : null;
    if (id && !existing) throw new Error('Unknown MCP server.');
    const next = normalizeMcpServerInput(source, { allowKeep: Boolean(existing) });
    if (!existing && this.#servers.length >= MCP_LIMITS.servers) throw new Error(`At most ${MCP_LIMITS.servers} MCP servers can be configured.`);
    this.#assertNameAvailable(next.name, existing?.id);

    const env = this.#buildEnv(next.env, existing?.env ?? {});
    const server = { id: existing?.id ?? this.#uniqueId(next.name, this.#servers), name: next.name, command: next.command, args: next.args, enabled: next.enabled, env };
    await this.#commit(existing ? this.#servers.map((item) => (item.id === existing.id ? server : item)) : [...this.#servers, server]);
    return this.rendererValue();
  }

  async setEnabled(serverId, enabled) {
    const existing = this.#servers.find((server) => server.id === serverId);
    if (!existing) throw new Error('Unknown MCP server.');
    await this.#commit(this.#servers.map((server) => (server === existing ? { ...server, enabled: enabled === true } : server)));
    return this.rendererValue();
  }

  async remove(serverId) {
    if (!this.#servers.some((server) => server.id === serverId)) throw new Error('Unknown MCP server.');
    await this.#commit(this.#servers.filter((server) => server.id !== serverId));
    return this.rendererValue();
  }

  /** Add servers from pasted `mcpServers` JSON. Imported servers start disabled so their commands can be reviewed first. */
  async importJson(text) {
    const { servers: parsed, skipped } = parseMcpServersJson(text);
    const added = [];
    const next = [...this.#servers];
    for (const candidate of parsed) {
      if (next.length >= MCP_LIMITS.servers) { skipped.push({ name: candidate.name, reason: `The limit of ${MCP_LIMITS.servers} servers was reached.` }); continue; }
      if (next.some((server) => server.name.toLowerCase() === candidate.name.toLowerCase())) { skipped.push({ name: candidate.name, reason: 'A server with this name already exists.' }); continue; }
      try {
        const env = this.#buildEnv(candidate.env, {});
        next.push({ id: this.#uniqueId(candidate.name, next), name: candidate.name, command: candidate.command, args: candidate.args, enabled: false, env });
        added.push(candidate.name);
      } catch (error) {
        skipped.push({ name: candidate.name, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    if (added.length) await this.#commit(next);
    return { settings: this.rendererValue(), imported: added, skipped };
  }

  // --- internals ---

  #buildEnv(requested, saved) {
    const env = Object.create(null);
    const entries = Object.entries(requested);
    if (entries.some(([, value]) => value !== null)) this.#requireEncryption();
    for (const [key, value] of entries) {
      if (value === null) {
        if (typeof saved[key] !== 'string') throw new Error(`Environment variable ${key} has no saved value. Enter one.`);
        env[key] = saved[key];
      } else {
        env[key] = this.#safeStorage.encryptString(value).toString('base64');
      }
    }
    return env;
  }

  #requireEncryption() {
    const storage = this.#storageStatus(this.#safeStorage);
    if (!storage.available) {
      throw new Error(`Cuppet will not store MCP environment values in plaintext. ${storage.reason ?? 'OS credential encryption is unavailable'}.`);
    }
  }

  #decryptEnv(stored) {
    const keys = Object.keys(stored);
    const env = Object.create(null);
    if (!keys.length) return { env, failed: false };
    if (!this.#storageStatus(this.#safeStorage).available) return { env, failed: true };
    for (const key of keys) {
      try { env[key] = this.#safeStorage.decryptString(Buffer.from(stored[key], 'base64')); } catch { return { env: Object.create(null), failed: true }; }
    }
    return { env, failed: false };
  }

  #assertNameAvailable(name, ownId) {
    const lower = name.toLowerCase();
    if (this.#servers.some((server) => server.id !== ownId && server.name.toLowerCase() === lower)) {
      throw new Error(`An MCP server named "${name}" already exists.`);
    }
  }

  #uniqueId(name, among) {
    const base = mcpServerSlug(name) || 'server';
    let id = base;
    for (let suffix = 2; among.some((server) => server.id === id); suffix += 1) {
      const tail = `-${suffix}`;
      id = `${base.slice(0, 32 - tail.length)}${tail}`;
    }
    return id;
  }

  async #commit(servers) {
    await writeAtomically(this.#path, `${JSON.stringify({ version: FILE_VERSION, servers }, null, 2)}\n`);
    this.#servers = servers;
  }
}

async function writeAtomically(path, content) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
