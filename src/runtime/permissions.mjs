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
const AUTO_PROJECT_ACTIONS = new Set(['delete', 'agent-tool']);
const PLAN_MUTATING_ACTIONS = new Set(['edit', 'write', 'delete', 'bash', 'browser-control', 'agent-tool']);
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
  #emit; #interactive; #pending = new Map(); #autoSessions = new Set(); #fullSessions = new Set(); #always = new Map();

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

  autoStatus(sessionId) {
    const fullAccess = this.#fullSessions.has(sessionId);
    const enabled = this.#autoSessions.has(sessionId);
    return { sessionId, enabled, fullAccess, mode: fullAccess ? 'full' : enabled ? 'auto' : 'default' };
  }
  setAuto(sessionId, enabled) {
    if (!sessionId) throw new Error('sessionId is required');
    if (enabled === 'full') {
      this.#fullSessions.add(sessionId);
      this.#autoSessions.delete(sessionId);
    } else if (enabled) {
      this.#autoSessions.add(sessionId);
      this.#fullSessions.delete(sessionId);
    } else {
      this.#autoSessions.delete(sessionId);
      this.#fullSessions.delete(sessionId);
    }
    return this.autoStatus(sessionId);
  }
  forgetSession(sessionId) {
    if (!sessionId) return { sessionId, forgotten: false };
    const removedAuto = this.#autoSessions.delete(sessionId);
    const removedFull = this.#fullSessions.delete(sessionId);
    const removedAlways = this.#always.delete(sessionId);
    let forgotten = removedAuto || removedFull || removedAlways;
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
    const immediate = await immediateDecision({ action, resources: normalized, projectRoot, planMode, auto: this.#autoSessions.has(sessionId), fullAccess: this.#fullSessions.has(sessionId) });
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

async function immediateDecision({ action, resources, projectRoot, planMode, auto, fullAccess }) {
  if (['tst_explore', 'cuppet_plan', 'cuppet_memory_search'].includes(action)) return { effect: 'allow', source: 'read-only-tool' };
  if (action === 'browser-read') return { effect: 'allow', source: 'explicit-browser-read' };
  if (action === 'bash' && resources.length === 1 && isSafeAutoBashCommand(resources[0] ?? '')) return { effect: 'allow', source: 'safe-bash' };
  if (planMode && PLAN_MUTATING_ACTIONS.has(action)) return { effect: 'deny', code: 'plan_mode_read_only', reason: 'Plan mode is read-only; mutating tools, browser control, agent side effects, and arbitrary shell commands are blocked.' };
  if (auto && action === 'web-fetch') return { effect: 'allow', source: 'session-auto-web' };

  if (fullAccess) {
    if (!projectRoot && (WORKSPACE_ACTIONS.has(action) || action === 'delete' || action === 'bash')) {
      return { effect: 'deny', code: 'project_required', reason: 'Full access filesystem and shell actions require a project-bound session.' };
    }
    if (action === 'delete') {
      if (!resources.length) return { effect: 'deny', code: 'full_access_delete_unverified', reason: 'Full access blocked a delete because its target path could not be verified inside the active project.' };
      const inside = await Promise.all(resources.map((resource) => isDeleteTargetInsideProject(resource, projectRoot)));
      if (!inside.every(Boolean)) return { effect: 'deny', code: 'full_access_delete_outside_project', reason: 'Full access never permits deletion outside the active project root.' };
      return { effect: 'allow', source: 'session-full-access' };
    }
    if (action === 'bash') {
      const command = resources[0] ?? '';
      const deletion = await inspectFullAccessDeletion(command, projectRoot);
      if (!deletion.allowed) return { effect: 'deny', code: deletion.code, reason: deletion.reason };
      return { effect: 'allow', source: 'session-full-access' };
    }
    return { effect: 'allow', source: 'session-full-access' };
  }

  if (WORKSPACE_ACTIONS.has(action)) {
    if (!projectRoot) return { effect: 'deny', code: 'project_required', reason: 'Filesystem tools require a project-bound session.' };
    if (resources.some((resource) => isProtectedResource(resource))) return { effect: 'deny', code: 'protected_resource', reason: 'Cuppet protected runtime/credential files cannot be accessed by the coding model.' };

    const envExample = resources.length > 0 && resources.every(isEnvExampleResource);
    const safe = resources.length > 0 && (await Promise.all(resources.map((resource) => isSafeWorkspaceResource(resource, projectRoot)))).every(Boolean);
    const projectScoped = resources.length > 0 && (await Promise.all(resources.map((resource) => isProjectScopedResource(resource, projectRoot)))).every(Boolean);

    if (action === 'read' && process.env.CUPPET_GRAPH_FIRST_GATE !== '1' && (safe || envExample)) {
      return { effect: 'allow', source: 'workspace-read' };
    }
    if (auto && projectScoped) return { effect: 'allow', source: 'session-auto' };
    return { effect: 'ask', autoEligible: auto ? projectScoped : safe };
  }

  if (auto && AUTO_PROJECT_ACTIONS.has(action)) {
    if (!projectRoot || !resources.length) return { effect: 'ask', autoEligible: false };
    if (resources.some((resource) => isProtectedResource(resource))) return { effect: 'deny', code: 'protected_resource', reason: 'Cuppet protected runtime/credential files cannot be accessed by the coding model.' };
    const projectScoped = (await Promise.all(resources.map((resource) => isProjectScopedResource(resource, projectRoot)))).every(Boolean);
    if (projectScoped) return { effect: 'allow', source: 'session-auto-project' };
    return { effect: 'ask', autoEligible: false };
  }

  if (action === 'bash') {
    if (auto && projectRoot && resources.length === 1 && await isAutoProjectBashCommand(resources[0], projectRoot)) return { effect: 'allow', source: 'session-auto-project' };
    return { effect: 'ask', autoEligible: false };
  }
  return { effect: 'ask', autoEligible: false };
}

export async function inspectFullAccessDeletion(command, projectRoot) {
  const source = String(command ?? '').trim();
  if (!source) return { allowed: true, deletion: false };
  const scans = deletionTargets(source);
  if (!scans.deletion) return { allowed: true, deletion: false };
  if (!projectRoot || scans.unknown || scans.targets.length === 0) {
    return {
      allowed: false,
      deletion: true,
      code: 'full_access_delete_unverified',
      reason: 'Full access blocked a delete because its target path could not be verified inside the active project.',
    };
  }
  for (const target of scans.targets) {
    if (!(await isDeleteTargetInsideProject(target, projectRoot))) {
      return {
        allowed: false,
        deletion: true,
        code: 'full_access_delete_outside_project',
        reason: `Full access never permits deletion outside the active project root: ${String(target).slice(0, 240)}`,
      };
    }
  }
  return { allowed: true, deletion: true, targets: scans.targets };
}

async function isDeleteTargetInsideProject(resource, workspaceRoot) {
  const target = String(resource ?? '').trim();
  if (!target || !workspaceRoot || target.includes('\0') || target.startsWith('~') || /[$`]/.test(target)) return false;
  const root = await realpath(workspaceRoot).catch(() => resolve(workspaceRoot));
  const candidate = isAbsolute(target) ? resolve(target) : resolve(root, target);
  if (!isAtOrInside(root, candidate)) return false;
  return nearestExistingAncestorIsInside(candidate, root);
}

function deletionTargets(command) {
  const tokens = shellTokens(command);
  const segments = splitShellSegments(tokens);
  const targets = [];
  let deletion = false;
  let unknown = false;
  for (const segment of segments) {
    const result = deletionTargetsForSegment(segment);
    deletion ||= result.deletion;
    unknown ||= result.unknown;
    targets.push(...result.targets);
  }
  return { deletion, unknown, targets: [...new Set(targets)] };
}

function deletionTargetsForSegment(input) {
  let tokens = [...input];
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
  while (tokens.length && ['sudo', 'command', 'builtin', 'nohup'].includes(commandName(tokens[0]))) {
    const wrapper = commandName(tokens.shift());
    if (wrapper === 'sudo') while (tokens[0]?.startsWith('-')) tokens.shift();
  }
  if (commandName(tokens[0]) === 'env') {
    tokens.shift();
    while (tokens.length && (tokens[0].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]))) tokens.shift();
  }
  if (!tokens.length) return { deletion: false, unknown: false, targets: [] };

  const name = commandName(tokens[0]);
  const args = tokens.slice(1);
  if (['bash', 'sh', 'zsh', 'fish'].includes(name)) {
    const index = args.findIndex((value) => value === '-c' || value === '-lc');
    return index >= 0 && args[index + 1] ? deletionTargets(args[index + 1]) : { deletion: false, unknown: false, targets: [] };
  }
  if (['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'].includes(name)) {
    const index = args.findIndex((value) => ['-command', '-c'].includes(value.toLowerCase()));
    return index >= 0 && args[index + 1] ? deletionTargets(args.slice(index + 1).join(' ')) : { deletion: false, unknown: false, targets: [] };
  }
  if (['rm', 'rmdir', 'unlink', 'rimraf', 'trash', 'trash-put', 'del', 'erase', 'rd', 'remove-item'].includes(name)) {
    const operands = commandOperands(args);
    return { deletion: true, unknown: operands.length === 0, targets: operands };
  }
  if (name === 'find' && args.some((value) => value.toLowerCase() === '-delete')) {
    const roots = [];
    for (const value of args) {
      if (value === '--') continue;
      if (value.startsWith('-') || ['!', '(', ')'].includes(value)) break;
      roots.push(value);
    }
    return { deletion: true, unknown: false, targets: roots.length ? roots : ['.'] };
  }
  if (name === 'git') {
    let cwd = '.';
    let index = 0;
    while (index < args.length) {
      if (args[index] === '-C') {
        if (!args[index + 1]) return { deletion: true, unknown: true, targets: [] };
        cwd = args[index + 1];
        index += 2;
        continue;
      }
      if (args[index].startsWith('-')) { index += 1; continue; }
      break;
    }
    const subcommand = String(args[index] ?? '').toLowerCase();
    if (subcommand === 'clean') return { deletion: true, unknown: false, targets: [cwd] };
    if (subcommand === 'rm') {
      const operands = commandOperands(args.slice(index + 1));
      const base = cwd === '.' ? '' : `${cwd.replace(/[\\/]$/, '')}/`;
      return { deletion: true, unknown: operands.length === 0, targets: operands.map((value) => `${base}${value}`) };
    }
  }
  if (name === 'xargs') {
    const nested = args.findIndex((value) => ['rm', 'rmdir', 'unlink', 'rimraf'].includes(commandName(value)));
    if (nested >= 0) {
      const result = deletionTargetsForSegment(args.slice(nested));
      return { ...result, unknown: true };
    }
  }
  return { deletion: false, unknown: false, targets: [] };
}

function commandOperands(args) {
  const result = [];
  let options = true;
  for (const value of args) {
    if (value === '--') { options = false; continue; }
    if (options && value.startsWith('-')) continue;
    if (/^[0-9]*[<>]/.test(value)) continue;
    result.push(value);
  }
  return result;
}

function commandName(value) {
  return String(value ?? '').replaceAll('\\', '/').split('/').pop().toLowerCase();
}

function splitShellSegments(tokens) {
  const segments = [[]];
  for (const token of tokens) {
    if ([';', '&&', '||', '|', '\n'].includes(token)) {
      if (segments.at(-1).length) segments.push([]);
    } else segments.at(-1).push(token);
  }
  return segments.filter((segment) => segment.length);
}

function shellTokens(source) {
  const tokens = [];
  let token = '';
  let quote = '';
  let escaped = false;
  const push = () => { if (token) { tokens.push(token); token = ''; } };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) { token += char; escaped = false; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (char === quote) quote = '';
      else token += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === '\n') { push(); tokens.push('\n'); continue; }
    if (/\s/.test(char)) { push(); continue; }
    if (char === ';' || char === '|') {
      push();
      if (char === '|' && source[index + 1] === '|') { tokens.push('||'); index += 1; }
      else tokens.push(char);
      continue;
    }
    if (char === '&' && source[index + 1] === '&') { push(); tokens.push('&&'); index += 1; continue; }
    token += char;
  }
  push();
  return tokens;
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

export async function isProjectScopedResource(resource, workspaceRoot) {
  if (!resource || resource.trim() !== resource || resource.includes('\0') || resource.startsWith('~') || resource.startsWith('file:') || UNSAFE_RESOURCE_CHARACTERS.test(resource)) return false;
  const root = await realpath(workspaceRoot).catch(() => resolve(workspaceRoot));
  const candidate = isAbsolute(resource) ? resolve(resource) : resolve(root, resource);
  if (!isAtOrInside(root, candidate)) return false;
  return nearestExistingAncestorIsInside(candidate, root);
}

export async function isAutoProjectBashCommand(command, projectRoot) {
  const source = String(command ?? '').trim();
  if (!source || !projectRoot || source.length > 8000) return false;
  const deletion = await inspectFullAccessDeletion(source, projectRoot);
  if (!deletion.allowed) return false;
  if (/(^|[\s"'=])(?:~(?:[\/]|$)|\.\.(?:[\/]|$)|file:)/i.test(source)) return false;
  if (/`|\$\(/.test(source)) return false;
  if (/\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[^}]+\})(?:[\/]|$)|%USERPROFILE%/i.test(source)) return false;

  const withoutUrls = source.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`]+/gi, '');
  const candidates = [];
  for (const match of withoutUrls.matchAll(/(^|[\s"'=])(\/[^\s"'`;|&<>]*)/g)) if (match[2]) candidates.push(match[2]);
  for (const match of withoutUrls.matchAll(/(^|[\s"'=])([A-Za-z]:[\\/][^\s"'`;|&<>]*)/g)) if (match[2]) candidates.push(match[2]);
  for (const candidate of candidates) if (!(await isProjectScopedResource(candidate, projectRoot))) return false;
  return true;
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
