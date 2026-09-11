import { isAbsolute, relative, resolve, sep } from 'node:path';

export class AcpHostBridge {
  #providerId;
  #projectRoot;
  #executeTool;
  #requestAgentPermission;
  #terminals = new Map();
  #nextTerminal = 1;

  constructor({ providerId, projectRoot = null, executeTool, requestAgentPermission }) {
    this.#providerId = providerId;
    this.#projectRoot = projectRoot ? resolve(projectRoot) : null;
    this.setHandlers({ executeTool, requestAgentPermission });
  }

  setHandlers({ executeTool, requestAgentPermission } = {}) {
    this.#executeTool = typeof executeTool === 'function' ? executeTool : undefined;
    this.#requestAgentPermission = typeof requestAgentPermission === 'function' ? requestAgentPermission : undefined;
  }

  async handle(message) {
    const method = String(message?.method ?? '');
    const params = record(message?.params);
    const requestId = message?.id;
    if (method === 'fs/read_text_file') {
      const result = await this.#runTool(requestId, 'workspace_read', {
        path: params.path,
        ...(Number.isInteger(params.line) ? { start_line: Math.max(1, params.line) } : {}),
        ...(Number.isInteger(params.limit) ? { line_limit: Math.max(1, params.limit) } : {}),
      });
      return { content: result.output };
    }
    if (method === 'fs/write_text_file') {
      await this.#runTool(requestId, 'workspace_write', { path: params.path, content: params.content });
      return {};
    }
    if (method === 'terminal/create') {
      const command = terminalCommand(params, this.#projectRoot);
      const result = await this.#runTool(requestId, 'bash', { command, timeout_ms: 120_000 });
      const terminalId = `cuppet-acp-${this.#nextTerminal++}`;
      const exitCode = result.success === true ? 0 : extractExitCode(result.output, 1);
      this.#terminals.set(terminalId, { output: String(result.output ?? ''), exitCode });
      return { terminalId };
    }
    if (method === 'terminal/output') {
      const terminal = this.#terminal(params.terminalId);
      return { output: terminal.output, truncated: false, exitStatus: { exitCode: terminal.exitCode, signal: null } };
    }
    if (method === 'terminal/wait_for_exit') {
      const terminal = this.#terminal(params.terminalId);
      return { exitCode: terminal.exitCode, signal: null };
    }
    if (method === 'terminal/release') {
      this.#terminals.delete(String(params.terminalId ?? ''));
      return {};
    }
    if (method === 'terminal/kill') return {};
    if (method === 'session/request_permission') return this.#permission(params);
    const error = new Error(`Unsupported ACP client request: ${method}`);
    error.rpcCode = -32601;
    throw error;
  }

  async #runTool(requestId, name, args) {
    if (typeof this.#executeTool !== 'function') throw new Error('Cuppet tool bridge is unavailable for this ACP request.');
    const result = await this.#executeTool({
      id: `acp_${this.#providerId}_${String(requestId).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80)}`,
      source: 'acp-host',
      name,
      arguments: JSON.stringify(args),
    });
    if (result?.success !== true) throw new Error(String(result?.output || `${name} failed.`));
    return result;
  }

  async #permission(params) {
    const options = Array.isArray(params.options) ? params.options : [];
    let decision = 'reject';
    try {
      if (typeof this.#requestAgentPermission === 'function') {
        decision = await this.#requestAgentPermission({
          kind: String(params.toolCall?.kind ?? 'other'),
          title: String(params.toolCall?.title ?? 'Agent tool'),
          locations: Array.isArray(params.toolCall?.locations) ? params.toolCall.locations : [],
          rawInput: params.toolCall?.rawInput,
        });
      }
    } catch (error) {
      if (error?.name === 'AbortError') return { outcome: { outcome: 'cancelled' } };
      decision = 'reject';
    }
    const desired = decision === 'always' ? 'allow_always' : decision === 'once' ? 'allow_once' : 'reject_once';
    const option = options.find((item) => item?.kind === desired)
      ?? (decision === 'reject'
        ? options.find((item) => String(item?.kind ?? '').startsWith('reject'))
        : options.find((item) => String(item?.kind ?? '').startsWith('allow')));
    if (!option?.optionId) return { outcome: { outcome: 'cancelled' } };
    return { outcome: { outcome: 'selected', optionId: option.optionId } };
  }

  #terminal(id) {
    const terminal = this.#terminals.get(String(id ?? ''));
    if (!terminal) throw new Error('Unknown ACP terminal id.');
    return terminal;
  }
}

function terminalCommand(params, projectRoot) {
  const command = text(params.command);
  if (!command) throw new Error('ACP terminal command is required.');
  const args = Array.isArray(params.args) ? params.args.map((item) => String(item)) : [];
  const env = (Array.isArray(params.env) ? params.env : []).flatMap((item) => {
    const name = text(item?.name);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return [];
    return [`${name}=${shellQuote(String(item?.value ?? ''))}`];
  });
  let prefix = '';
  const requestedCwd = text(params.cwd);
  if (requestedCwd && projectRoot) {
    const root = resolve(projectRoot);
    const target = isAbsolute(requestedCwd) ? resolve(requestedCwd) : resolve(root, requestedCwd);
    const within = relative(root, target);
    if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error('ACP terminal cwd escapes the project workspace.');
    if (within) prefix = `cd ${shellQuote(target)} && `;
  }
  return `${prefix}${env.length ? `${env.join(' ')} ` : ''}${[command, ...args].map(shellQuote).join(' ')}`;
}

function shellQuote(value) {
  const stringValue = String(value);
  if (process.platform === 'win32') return `"${stringValue.replaceAll('"', '\\"')}"`;
  return `'${stringValue.replaceAll("'", "'\\''")}'`;
}
function extractExitCode(value, fallback = 1) { const match = String(value ?? '').match(/exit code:\s*(-?\d+)/i); return match ? Number(match[1]) : fallback; }
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
