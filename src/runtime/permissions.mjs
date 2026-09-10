import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const MAX_COMMAND_LENGTH = 256;
const PLAIN_COMMAND = /^[A-Za-z0-9._:=+-]+(?: [A-Za-z0-9._:=+-]+)*$/;
const STATUS_FLAGS = new Set(['--short', '--branch', '--porcelain', '--porcelain=v1', '-s', '-b', '-sb']);
const LOG_FLAGS = new Set(['--oneline', '--no-decorate', '--no-show-signature', '--all', '-1']);
const BRANCH_FLAGS = new Set(['--show-current', '--all', '--verbose', '-a', '-v', '-vv']);
const LS_FILES_FLAGS = new Set(['--cached', '--modified', '--deleted', '--others', '--exclude-standard', '--stage']);
const LS_FLAGS = new Set(['-a', '-l', '-h', '-la', '-al', '-lah', '-lha', '--all', '--long', '--human-readable']);
const VERSION_COMMANDS = new Set([
  'git --version', 'node --version', 'npm --version', 'pnpm --version', 'yarn --version', 'bun --version', 'deno --version',
  'python --version', 'python3 --version', 'cargo --version', 'rustc --version', 'go version',
]);
const WORKSPACE_ACTIONS = new Set(['read', 'edit', 'write']);
const UNSAFE_RESOURCE_CHARACTERS = /[\\*?\[\]{}]/;

export class PermissionDeniedError extends Error {
  constructor(message, { code = 'permission_denied', requestId = null } = {}) {
    super(message);
    this.name = 'PermissionDeniedError';
    this.code = code;
    this.requestId = requestId;
  }
}

export class PermissionBroker {
  #emit; #interactive; #pending = new Map(); #autoSessions = new Set(); #always = new Map();

  constructor({ emit = () => {}, interactive = true } = {}) {
    this.#emit = emit;
    this.#interactive = interactive;
  }

  close() {
    for (const pending of this.#pending.values()) {
      pending.signal?.removeEventListener('abort', pending.abortListener);
      pending.reject(abortError());
    }
    this.#pending.clear();
  }

  autoStatus(sessionId) { return { sessionId, enabled: this.#autoSessions.has(sessionId) }; }
  setAuto(sessionId, enabled) {
    if (!sessionId) throw new Error('sessionId is required');
    if (enabled) this.#autoSessions.add(sessionId); else this.#autoSessions.delete(sessionId);
    return this.autoStatus(sessionId);
  }
  forgetSession(sessionId) {
    if (!sessionId) return { sessionId, forgotten: false };
    const removedAuto = this.#autoSessions.delete(sessionId);
    const removedAlways = this.#always.delete(sessionId);
    let forgotten = removedAuto || removedAlways;
    for (const [requestId, pending] of this.#pending) {
      if (pending.request.sessionId !== sessionId) continue;
      this.#pending.delete(requestId);
      pending.signal?.removeEventListener('abort', pending.abortListener);
      pending.reject(abortError());
      forgotten = true;
    }
    return { sessionId, forgotten };
  }

  list(sessionId = null) {
    return [...this.#pending.values()]
      .map((entry) => entry.request)
      .filter((request) => !sessionId || request.sessionId === sessionId);
  }

  reply(requestId, reply = 'reject') {
    const pending = this.#pending.get(requestId);
    if (!pending) return { resolved: false, requestId };
    this.#pending.delete(requestId);
    pending.signal?.removeEventListener('abort', pending.abortListener);
    if (reply === 'always') {
      let approvals = this.#always.get(pending.request.sessionId);
      if (!approvals) { approvals = new Set(); this.#always.set(pending.request.sessionId, approvals); }
      approvals.add(pending.fingerprint);
    }
    const allowed = reply === 'once' || reply === 'always';
    this.#emit({ type: 'permission.resolved', sessionId: pending.request.sessionId, requestId, reply, allowed });
    if (allowed) pending.resolve({ allowed: true, source: reply === 'always' ? 'session-exact' : 'user-once', requestId });
    else pending.reject(new PermissionDeniedError('Permission rejected by user.', { requestId }));
    return { resolved: true, requestId, reply };
  }

  async authorize({ sessionId, action, resources = [], projectRoot = null, description = '', planMode = false, signal, fingerprintKey = '' }) {
    const normalized = resources.slice(0, 16).map((value) => String(value).slice(0, 1024));
    const boundedFingerprintKey = String(fingerprintKey ?? '').slice(0, 512);
    const immediate = await immediateDecision({ action, resources: normalized, projectRoot, planMode, auto: this.#autoSessions.has(sessionId) });
    if (immediate.effect === 'allow') return { allowed: true, source: immediate.source };
    if (immediate.effect === 'deny') throw new PermissionDeniedError(immediate.reason, { code: immediate.code });

    const fingerprint = permissionFingerprint(action, normalized, boundedFingerprintKey);
    if (this.#always.get(sessionId)?.has(fingerprint)) return { allowed: true, source: 'session-exact' };
    if (!this.#interactive) throw new PermissionDeniedError('Permission requires interaction in a non-interactive runtime.', { code: 'interaction_required' });
    if (signal?.aborted) throw abortError();

    const request = {
      id: `perm_${randomUUID()}`,
      sessionId,
      action,
      resources: normalized,
      description: String(description).slice(0, 500),
      createdAt: Date.now(),
      autoEligible: Boolean(immediate.autoEligible),
    };

    return new Promise((resolvePromise, reject) => {
      const abortListener = () => {
        if (!this.#pending.delete(request.id)) return;
        reject(abortError());
      };
      if (signal) signal.addEventListener('abort', abortListener, { once: true });
      this.#pending.set(request.id, { request, fingerprint, resolve: resolvePromise, reject, signal, abortListener });
      this.#emit({ type: 'permission.requested', request });
    });
  }
}

async function immediateDecision({ action, resources, projectRoot, planMode, auto }) {
  if (['tst_explore', 'cuppet_plan', 'cuppet_memory_search'].includes(action)) return { effect: 'allow', source: 'read-only-tool' };
  if (action === 'bash' && resources.length === 1 && isSafeAutoBashCommand(resources[0] ?? '')) return { effect: 'allow', source: 'safe-bash' };
  if (planMode && ['edit', 'write', 'bash'].includes(action)) return { effect: 'deny', code: 'plan_mode_read_only', reason: 'Plan mode is read-only; mutating tools and arbitrary shell commands are blocked.' };

  if (WORKSPACE_ACTIONS.has(action)) {
    if (!projectRoot) return { effect: 'deny', code: 'project_required', reason: 'Filesystem tools require a project-bound session.' };
    if (resources.some((resource) => isProtectedResource(resource))) return { effect: 'deny', code: 'protected_resource', reason: 'Cuppet protected runtime/credential files cannot be accessed by the coding model.' };

    const envExample = resources.length > 0 && resources.every(isEnvExampleResource);
    const safe = resources.length > 0 && (await Promise.all(resources.map((resource) => isSafeWorkspaceResource(resource, projectRoot)))).every(Boolean);

    if (action === 'read' && process.env.CUPPET_GRAPH_FIRST_GATE !== '1' && (safe || envExample)) {
      return { effect: 'allow', source: 'workspace-read' };
    }
    if (auto && safe) return { effect: 'allow', source: 'session-auto' };
    return { effect: 'ask', autoEligible: safe };
  }

  if (action === 'bash') return { effect: 'ask', autoEligible: false };
  return { effect: 'ask', autoEligible: false };
}

export function isSafeAutoBashCommand(command) {
  if (command.length === 0 || command.length > MAX_COMMAND_LENGTH || command.trim() !== command || !PLAIN_COMMAND.test(command)) return false;
  if (VERSION_COMMANDS.has(command)) return true;
  const tokens = command.split(' ');
  if (tokens.length === 1) return tokens[0] === 'pwd' || tokens[0] === 'ls';
  if (tokens[0] === 'ls') return tokens.slice(1).every((token) => LS_FLAGS.has(token));
  if (tokens[0] !== 'git') return false;
  const [, subcommand, ...args] = tokens;
  switch (subcommand) {
    case 'status': return args.every((value) => STATUS_FLAGS.has(value));
    case 'log': return args.includes('--oneline') && args.every((value) => LOG_FLAGS.has(value));
    case 'branch': return args.every((value) => BRANCH_FLAGS.has(value));
    case 'ls-files': return args.every((value) => LS_FILES_FLAGS.has(value));
    case 'rev-parse': return args.length === 1 && new Set(['--show-toplevel', '--is-inside-work-tree', '--git-dir']).has(args[0]);
    default: return false;
  }
}

export async function isSafeWorkspaceResource(resource, workspaceRoot) {
  if (!resource || resource.trim() !== resource || resource.includes('\0') || resource.startsWith('~') || resource.startsWith('file:') || UNSAFE_RESOURCE_CHARACTERS.test(resource)) return false;
  const root = await realpath(workspaceRoot).catch(() => resolve(workspaceRoot));
  const candidate = isAbsolute(resource) ? resolve(resource) : resolve(root, resource);
  const workspacePath = relative(root, candidate);
  if (!workspacePath || !isAtOrInside(root, candidate) || isSensitivePath(workspacePath)) return false;
  return nearestExistingAncestorIsInside(candidate, root);
}

export function isSensitivePath(path) {
  const parts = String(path).split(/[\\/]/).map((part) => part.toLowerCase());
  return parts.some((part) => part === '.env' || part.startsWith('.env.') || part.includes('credentials') || part.endsWith('.pem') || part.endsWith('.key') || part === 'ltm-trie.json');
}

function isEnvExampleResource(resource) {
  const normalized = String(resource).replaceAll('\\', '/').toLowerCase();
  return normalized === '.env.example' || normalized.endsWith('/.env.example');
}
function isProtectedResource(resource) {
  const normalized = String(resource).replaceAll('\\', '/').toLowerCase().replace(/^\.\//, '');
  return normalized === '.claude.json' || normalized.endsWith('/.claude.json') ||
    normalized === '.cuppet/credentials.json' || normalized.endsWith('/.cuppet/credentials.json') ||
    normalized === '.cuppet/ltm-trie.json' || normalized.endsWith('/.cuppet/ltm-trie.json');
}

async function nearestExistingAncestorIsInside(candidate, root) {
  let ancestor = candidate;
  for (;;) {
    try { return isAtOrInside(root, await realpath(ancestor)); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) return false;
      const parent = dirname(ancestor);
      if (parent === ancestor) return false;
      ancestor = parent;
    }
  }
}
function isAtOrInside(root, candidate) { const path = relative(root, candidate); return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path); }
function permissionFingerprint(action, resources, fingerprintKey = '') { return `${action}\0${resources.join('\0')}\0${fingerprintKey}`; }
function abortError() { const error = new Error('Generation stopped'); error.name = 'AbortError'; return error; }
