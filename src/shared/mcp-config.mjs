// Validation and normalisation for user-configured MCP servers.
//
// Pure on purpose: no Electron, no filesystem. The main-process settings store, the runtime manager and the
// tests all share these rules, so what Settings accepts is exactly what the runtime will try to launch.

export const MCP_LIMITS = Object.freeze({
  servers: 16,
  nameChars: 40,
  commandChars: 1024,
  args: 64,
  argChars: 4096,
  env: 64,
  envKeyChars: 128,
  envValueChars: 8192,
  importChars: 64 * 1024,
});

const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SERVER_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const FORBIDDEN_ENV_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export class McpConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'McpConfigError';
  }
}

const fail = (message) => { throw new McpConfigError(message); };
const record = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const text = (value) => (typeof value === 'string' ? value : '');

/** Stable identifier used in tool names (`mcp__<id>__<tool>`). Letters, digits and single dashes only. */
export function mcpServerSlug(name) {
  return text(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/g, '');
}

export function isMcpServerId(value) {
  return typeof value === 'string' && SERVER_ID.test(value);
}

export function isMcpEnvName(value) {
  return typeof value === 'string' && value.length <= MCP_LIMITS.envKeyChars && ENV_KEY.test(value) && !FORBIDDEN_ENV_KEYS.has(value);
}

/**
 * Validate one server definition coming from the Settings form or an import.
 *
 * `env` maps variable name -> value. With `allowKeep`, a `null` value means "keep the value already saved for
 * this name"; that is how the form edits a server without ever being sent its stored secrets.
 */
export function normalizeMcpServerInput(input, { allowKeep = false } = {}) {
  const source = record(input);

  const name = text(source.name).trim();
  if (!name) fail('Server name is required.');
  if (name.length > MCP_LIMITS.nameChars || !NAME.test(name) || !mcpServerSlug(name)) {
    fail(`Server name must be 1–${MCP_LIMITS.nameChars} characters: letters, numbers, spaces, dots, dashes and underscores, starting with a letter or number.`);
  }

  const command = text(source.command).trim();
  if (!command) fail('Command is required.');
  if (command.length > MCP_LIMITS.commandChars || /[\0\r\n]/.test(command)) {
    fail(`Command must be a single line of at most ${MCP_LIMITS.commandChars} characters.`);
  }

  const rawArgs = source.args === undefined ? [] : source.args;
  if (!Array.isArray(rawArgs) || rawArgs.length > MCP_LIMITS.args) fail(`Arguments must be a list of at most ${MCP_LIMITS.args} items.`);
  const args = rawArgs.map((value) => {
    if (typeof value !== 'string' || value.length > MCP_LIMITS.argChars || value.includes('\0')) {
      fail(`Each argument must be text of at most ${MCP_LIMITS.argChars} characters.`);
    }
    return value;
  });

  const rawEnv = source.env === undefined ? {} : source.env;
  if (!rawEnv || typeof rawEnv !== 'object' || Array.isArray(rawEnv)) fail('Environment must be a set of NAME → value pairs.');
  const entries = Object.entries(rawEnv);
  if (entries.length > MCP_LIMITS.env) fail(`At most ${MCP_LIMITS.env} environment variables are allowed.`);
  const env = Object.create(null);
  for (const [key, value] of entries) {
    if (!isMcpEnvName(key)) {
      fail(`Invalid environment variable name: ${JSON.stringify(key.slice(0, 40))}.`);
    }
    if (value === null && allowKeep) { env[key] = null; continue; }
    if (typeof value !== 'string' || value.length > MCP_LIMITS.envValueChars || value.includes('\0')) {
      fail(`Environment variable ${key} must be text of at most ${MCP_LIMITS.envValueChars} characters.`);
    }
    env[key] = value;
  }

  return { name, command, args, env, enabled: source.enabled === undefined ? true : source.enabled === true };
}

/**
 * Read the `mcpServers` JSON that MCP server READMEs, Claude Desktop and Cursor all use:
 *   { "mcpServers": { "name": { "command": "npx", "args": ["-y", "pkg"], "env": { "KEY": "value" } } } }
 * A bare `{ "name": { "command": … } }` map is accepted too. Remote (url/http/sse) entries are reported as skipped.
 */
export function parseMcpServersJson(input) {
  const raw = text(input).trim();
  if (!raw) fail('Paste the MCP server JSON first.');
  if (raw.length > MCP_LIMITS.importChars) fail('That JSON is too large to import.');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { fail('That is not valid JSON.'); }
  const root = record(parsed);
  const map = record(root.mcpServers ?? root.servers ?? root);
  const servers = [];
  const skipped = [];
  for (const [name, definition] of Object.entries(map)) {
    const entry = record(definition);
    if (typeof entry.url === 'string' || ['http', 'sse', 'streamable-http'].includes(text(entry.type).toLowerCase())) {
      skipped.push({ name, reason: 'Remote (HTTP/SSE) servers are not supported yet; only local command servers are.' });
      continue;
    }
    if (typeof entry.command !== 'string') {
      skipped.push({ name, reason: 'No command to run.' });
      continue;
    }
    try {
      servers.push(normalizeMcpServerInput({ name, command: entry.command, args: entry.args, env: entry.env, enabled: false }));
    } catch (error) {
      skipped.push({ name, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  if (!servers.length && !skipped.length) fail('No MCP servers were found in that JSON.');
  return { servers, skipped };
}
