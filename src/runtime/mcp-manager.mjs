import { createHash } from 'node:crypto';
import { McpStdioClient } from './mcp-client.mjs';
import { MCP_LIMITS, isMcpEnvName, isMcpServerId } from '../shared/mcp-config.mjs';

const MAX_TOOLS_TOTAL = 96;
const MAX_TOOL_NAME = 64;
const MAX_DESCRIPTION = 3000;
const MAX_SCHEMA_CHARS = 32 * 1024;
const READY_WAIT_MS = 10_000;
const RETRY_COOLDOWN_MS = 15_000;

/**
 * Runs the user's MCP servers and presents their tools to the tool runtime.
 *
 * It follows the same shape as BrowserControlManager (`definitions()` / `has()` / `call()`), so tools arrive in
 * the existing tool loop and permission path. The configuration is pushed in from the main process with
 * `configure()` and lives only in this process's memory. Nothing here is persisted.
 */
export class McpServerManager {
  #emit; #clientFactory; #clientOptions; #now; #retryCooldownMs;
  /** @type {Map<string, any>} insertion order is configuration order, which keeps tool naming stable. */
  #servers = new Map();
  /** @type {Map<string, { serverId: string, mcpName: string, readOnly: boolean, definition: object }>} */
  #index = new Map();
  #closed = false;

  constructor({ emit = () => {}, clientFactory = (options) => new McpStdioClient(options), clientOptions = {}, now = () => Date.now(), retryCooldownMs = RETRY_COOLDOWN_MS } = {}) {
    this.#emit = emit;
    this.#clientFactory = clientFactory;
    this.#clientOptions = clientOptions;
    this.#now = now;
    this.#retryCooldownMs = retryCooldownMs;
  }

  /** Apply the configuration. Returns immediately; enabled servers start in the background. */
  configure(servers) {
    if (this.#closed) return [];
    const incoming = normalizeRuntimeServers(servers);
    const keep = new Set(incoming.map((server) => server.id));
    for (const [id, entry] of [...this.#servers]) {
      if (!keep.has(id)) { void this.#stop(entry); this.#servers.delete(id); }
    }
    const ordered = new Map();
    for (const config of incoming) {
      const existing = this.#servers.get(config.id);
      const signature = JSON.stringify([config.command, config.args, Object.entries(config.env), config.enabled, config.blocked ?? '']);
      if (existing && existing.signature === signature) {
        existing.config = config; // a rename alone must not restart the process
        ordered.set(config.id, existing);
        continue;
      }
      if (existing) void this.#stop(existing);
      const entry = { config, signature, state: 'stopped', message: '', client: null, tools: [], truncated: 0, startPromise: null, lastAttemptAt: 0 };
      ordered.set(config.id, entry);
      this.#servers.set(config.id, entry);
    }
    this.#servers = ordered;
    for (const entry of this.#servers.values()) {
      if (entry.client || entry.startPromise) continue;
      if (entry.config.blocked) this.#set(entry, 'error', entry.config.blocked);
      else if (!entry.config.enabled) this.#set(entry, 'disabled', '');
      else void this.#start(entry);
    }
    this.#rebuildIndex();
    return this.status();
  }

  status() {
    return [...this.#servers.values()].map((entry) => {
      const ready = entry.state === 'ready';
      const exposed = ready ? entry.tools.slice(0, entry.tools.length - entry.truncated) : [];
      return {
        id: entry.config.id,
        name: entry.config.name,
        state: entry.state,
        message: entry.message || (ready && entry.truncated ? `${entry.truncated} tool${entry.truncated === 1 ? ' was' : 's were'} not offered: Cuppet exposes at most ${MAX_TOOLS_TOTAL} MCP tools.` : ''),
        toolCount: exposed.length,
        tools: exposed.map((tool) => ({ name: tool.name, readOnly: tool.readOnly })),
      };
    });
  }

  /** True when at least one server is enabled, so a turn offers MCP tools as soon as they finish starting. */
  hasServers() {
    for (const entry of this.#servers.values()) if (entry.config.enabled && !entry.config.blocked) return true;
    return false;
  }

  definitions() {
    return [...this.#index.values()].map((tool) => structuredClone(tool.definition));
  }

  has(name) { return this.#index.has(String(name ?? '')); }

  describe(name) {
    const tool = this.#index.get(String(name ?? ''));
    if (!tool) return null;
    const entry = this.#servers.get(tool.serverId);
    return { serverId: tool.serverId, serverName: entry?.config.name ?? tool.serverId, toolName: tool.mcpName, readOnly: tool.readOnly };
  }

  async call(name, args = {}, { signal } = {}) {
    const tool = this.#index.get(String(name ?? ''));
    if (!tool) throw new Error(`MCP tool is unavailable: ${name}`);
    const entry = this.#servers.get(tool.serverId);
    if (!entry || entry.state !== 'ready' || !entry.client?.running) {
      throw new Error(`MCP server "${entry?.config.name ?? tool.serverId}" is not running (${entry?.state ?? 'removed'}). Check Settings → MCP.`);
    }
    const result = await entry.client.callTool(tool.mcpName, args, { signal });
    if (result.isError) throw new Error(result.output || `MCP tool failed: ${tool.mcpName}`);
    return { output: result.output || '(the tool returned no content)', contentItems: result.contentItems };
  }

  /**
   * Called at the start of a turn. Gives servers that are still starting a short moment to finish, and retries
   * servers that crashed (no more than once per cooldown) so a transient failure heals without a visit to Settings.
   */
  async ready({ timeoutMs = READY_WAIT_MS, signal } = {}) {
    if (this.#closed || signal?.aborted) return;
    for (const entry of this.#servers.values()) {
      if (entry.state === 'error' && entry.config.enabled && !entry.config.blocked && !entry.startPromise
        && this.#now() - entry.lastAttemptAt >= this.#retryCooldownMs) void this.#start(entry);
    }
    const starting = [...this.#servers.values()].map((entry) => entry.startPromise).filter(Boolean);
    if (!starting.length) return;
    let timer;
    let onAbort;
    await Promise.race([
      Promise.allSettled(starting),
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
        onAbort = resolve;
        signal?.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }

  async restart(serverId) {
    const entry = this.#servers.get(String(serverId ?? ''));
    if (!entry) throw new Error('Unknown MCP server.');
    if (entry.config.blocked) throw new Error(entry.config.blocked);
    if (!entry.config.enabled) throw new Error('Enable this server before restarting it.');
    await this.#stop(entry);
    await this.#start(entry);
    return this.status();
  }

  async close() {
    this.#closed = true;
    const entries = [...this.#servers.values()];
    this.#servers = new Map();
    this.#index = new Map();
    await Promise.allSettled(entries.map((entry) => this.#stop(entry)));
  }

  // --- internals ---

  #start(entry) {
    if (entry.startPromise) return entry.startPromise;
    const config = entry.config;
    entry.lastAttemptAt = this.#now();
    this.#set(entry, 'starting', '');
    const client = this.#clientFactory({
      ...this.#clientOptions,
      command: config.command,
      args: config.args,
      env: config.env,
      onToolsChanged: () => { if (entry.client === client && entry.state === 'ready') this.#adoptTools(entry, client); },
      onExit: ({ code, diagnostics }) => {
        // A failed start reports through its own rejection below; this is for a server that dies while running.
        if (entry.client !== client || entry.state !== 'ready') return;
        entry.client = null;
        entry.tools = [];
        this.#set(entry, 'error', `The server stopped unexpectedly${code === null || code === undefined ? '' : ` (code ${code})`}.${diagnostics ? `\n${diagnostics.slice(-600)}` : ''}`);
        this.#rebuildIndex();
      },
    });
    entry.client = client;
    const promise = (async () => {
      try {
        await client.start();
        if (entry.client !== client) { await client.close(); return; } // reconfigured or removed while starting
        this.#adoptTools(entry, client, { announce: false });
        this.#set(entry, 'ready', client.providesTools ? '' : 'This server does not provide tools.');
      } catch (error) {
        if (entry.client !== client) return;
        entry.client = null;
        entry.tools = [];
        this.#set(entry, 'error', error instanceof Error ? error.message : String(error));
      } finally {
        if (entry.startPromise === promise) entry.startPromise = null;
        this.#rebuildIndex();
      }
    })();
    entry.startPromise = promise;
    return promise;
  }

  async #stop(entry) {
    const client = entry.client;
    entry.client = null;
    entry.tools = [];
    if (client) await client.close().catch(() => undefined);
    if (this.#servers.get(entry.config.id) === entry) {
      this.#set(entry, entry.config.enabled ? 'stopped' : 'disabled', '');
      this.#rebuildIndex();
    }
  }

  #adoptTools(entry, client, { announce = true } = {}) {
    entry.tools = client.tools.map((tool) => ({ ...tool }));
    this.#rebuildIndex();
    if (announce) this.#announce();
  }

  #set(entry, state, message) {
    entry.state = state;
    entry.message = String(message ?? '').slice(0, 1600);
    this.#announce();
  }

  #announce() {
    try { this.#emit({ type: 'integration.mcp.updated', servers: this.status() }); } catch {}
  }

  /** Host-facing names are unique across servers, valid for provider APIs, and stable between rebuilds. */
  #rebuildIndex() {
    const index = new Map();
    for (const entry of this.#servers.values()) {
      entry.truncated = 0;
      if (entry.state !== 'ready') continue;
      for (const tool of entry.tools) {
        if (index.size >= MAX_TOOLS_TOTAL) { entry.truncated += 1; continue; }
        const hostName = uniqueToolName(entry.config.id, tool.name, index);
        index.set(hostName, {
          serverId: entry.config.id,
          mcpName: tool.name,
          readOnly: tool.readOnly === true,
          definition: {
            type: 'function',
            function: {
              name: hostName,
              description: `[MCP server "${entry.config.name}"] ${tool.description || tool.name}`.slice(0, MAX_DESCRIPTION),
              parameters: toolSchema(tool.inputSchema),
            },
          },
        });
      }
    }
    this.#index = index;
  }
}

function uniqueToolName(serverId, toolName, taken) {
  const safe = String(toolName).replace(/[^A-Za-z0-9_-]/g, '_');
  let name = `mcp__${serverId}__${safe}`;
  if (name.length > MAX_TOOL_NAME || taken.has(name)) {
    // Long or colliding names keep a readable prefix and gain a short digest of the original, so they stay stable.
    const digest = createHash('sha256').update(`${serverId}\0${toolName}`).digest('hex').slice(0, 8);
    name = `${name.slice(0, MAX_TOOL_NAME - 9)}_${digest}`;
  }
  for (let suffix = 2; taken.has(name); suffix += 1) name = `${name.slice(0, MAX_TOOL_NAME - 3)}_${suffix}`.slice(0, MAX_TOOL_NAME);
  return name;
}

// Provider APIs reject object schemas without `properties`, and an oversized schema is not worth the context.
// A permissive fallback still lets the model call the tool; the server validates its own arguments.
function toolSchema(value) {
  const fallback = { type: 'object', properties: {}, additionalProperties: true };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { type: 'object', properties: {} };
  let size = 0;
  try { size = JSON.stringify(value).length; } catch { return fallback; }
  if (size > MAX_SCHEMA_CHARS) return fallback;
  const schema = structuredClone(value);
  if (schema.type === undefined || schema.type === 'object') {
    schema.type = 'object';
    if (!schema.properties || typeof schema.properties !== 'object') schema.properties = {};
  }
  return schema;
}

function normalizeRuntimeServers(value) {
  const seen = new Set();
  const servers = [];
  for (const item of (Array.isArray(value) ? value : []).slice(0, MCP_LIMITS.servers)) {
    const source = item && typeof item === 'object' ? item : {};
    if (!isMcpServerId(source.id) || seen.has(source.id)) continue;
    const command = typeof source.command === 'string' ? source.command.trim() : '';
    if (!command || command.length > MCP_LIMITS.commandChars || /[\0\r\n]/.test(command)) continue;
    const args = Array.isArray(source.args) ? source.args.filter((arg) => typeof arg === 'string' && !arg.includes('\0')).slice(0, MCP_LIMITS.args) : [];
    const env = Object.create(null);
    if (source.env && typeof source.env === 'object' && !Array.isArray(source.env)) {
      for (const [key, val] of Object.entries(source.env).slice(0, MCP_LIMITS.env)) if (isMcpEnvName(key) && typeof val === 'string') env[key] = val;
    }
    seen.add(source.id);
    servers.push({
      id: source.id,
      name: typeof source.name === 'string' && source.name.trim() ? source.name.trim().slice(0, MCP_LIMITS.nameChars) : source.id,
      command,
      args,
      env,
      enabled: source.enabled === true,
      ...(typeof source.blocked === 'string' && source.blocked ? { blocked: source.blocked.slice(0, 400) } : {}),
    });
  }
  return servers;
}
