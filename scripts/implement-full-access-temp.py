from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    text = p.read_text()
    actual = text.count(old)
    if actual != count:
        raise SystemExit(f"{path}: expected {count} occurrence(s), found {actual}: {old[:100]!r}")
    p.write_text(text.replace(old, new, count))


# Renderer preference becomes tri-state.
replace('src/renderer/react/behavior-preferences.ts',
"export type PermissionMode = 'default' | 'auto';",
"export type PermissionMode = 'default' | 'auto' | 'full';")
replace('src/renderer/react/behavior-preferences.ts',
"export function readPermissionMode(): PermissionMode {\n  return localStorage.getItem(PREF_PERMISSION_MODE) === 'auto' ? 'auto' : 'default';\n}",
"export function readPermissionMode(): PermissionMode {\n  const value = localStorage.getItem(PREF_PERMISSION_MODE);\n  return value === 'auto' || value === 'full' ? value : 'default';\n}")

# General settings exposes the third mode.
replace('src/renderer/react/GeneralPanel.tsx',
"    const next: PermissionMode = value === 'auto' ? 'auto' : 'default';",
"    const next: PermissionMode = value === 'full' ? 'full' : value === 'auto' ? 'auto' : 'default';")
replace('src/renderer/react/GeneralPanel.tsx',
"<div><strong>Permissions</strong><span>Default asks before protected actions. Auto enables guarded automatic approval for eligible actions in project chats.</span></div>",
"<div><strong>Permissions</strong><span>Default asks before protected actions. Auto approves eligible project actions. Full access removes permission prompts in project chats, while destructive deletion outside the active project stays blocked.</span></div>")
replace('src/renderer/react/GeneralPanel.tsx',
"options={[{ value: 'default', label: 'Default' }, { value: 'auto', label: 'Auto' }]}",
"options={[{ value: 'default', label: 'Default' }, { value: 'auto', label: 'Auto' }, { value: 'full', label: 'Full access' }]}")

# Apply the preference to each active project session. General chats fail closed to Default.
replace('src/renderer/react/ChatPane.tsx',
"async function applyPermissionPreference(session: Session | null) {\n  if (!session?.id) return;\n  const auto = readPermissionMode() === 'auto' && Boolean(session.projectId);\n  await window.cuppet.permissions.autoSet(session.id, auto).catch(() => undefined);\n}",
"async function applyPermissionPreference(session: Session | null) {\n  if (!session?.id) return;\n  const preference = readPermissionMode();\n  const effective: boolean | 'full' = session.projectId\n    ? preference === 'full' ? 'full' : preference === 'auto'\n    : false;\n  await window.cuppet.permissions.autoSet(session.id, effective).catch(() => undefined);\n}")
replace('src/renderer/types.ts',
"    autoSet: (sessionId: string, enabled: boolean) => Promise<any>;",
"    autoSet: (sessionId: string, enabled: boolean | 'full') => Promise<any>;")

# Preserve the tri-state value across Electron IPC.
replace('src/main/main.mjs',
"  ipcMain.handle('cuppet:session:auto:set', (_event, sessionId, enabled) => request('session.auto.set', { sessionId, enabled: Boolean(enabled) }));",
"  ipcMain.handle('cuppet:session:auto:set', (_event, sessionId, enabled) => request('session.auto.set', { sessionId, enabled: enabled === 'full' ? 'full' : Boolean(enabled) }));")
replace('src/runtime/service.mjs',
"      case 'session.auto.set': {\n        const session = this.requireSession(params.sessionId);\n        if (params.enabled && !session.projectId) throw new Error('Guarded auto mode requires a project-bound session');\n        return this.#permissions.setAuto(session.id, Boolean(params.enabled));\n      }",
"      case 'session.auto.set': {\n        const session = this.requireSession(params.sessionId);\n        const requested = params.enabled === 'full' ? 'full' : Boolean(params.enabled);\n        if (requested && !session.projectId) throw new Error(requested === 'full' ? 'Full access requires a project-bound session' : 'Guarded auto mode requires a project-bound session');\n        return this.#permissions.setAuto(session.id, requested);\n      }")

# ACP providers expose deletion as its own permission class so the hard boundary can inspect it.
replace('src/runtime/tool-runtime.mjs',
"  if (['edit', 'delete', 'move', 'write'].includes(value)) return 'edit';",
"  if (value === 'delete') return 'delete';\n  if (['edit', 'move', 'write'].includes(value)) return 'edit';")
replace('src/runtime/tool-runtime.mjs',
"  return paths.length ? paths.slice(0, 16) : [String(request?.title || request?.kind || 'agent-tool').slice(0, 1024)];",
"  if (paths.length) return paths.slice(0, 16);\n  return String(request?.kind ?? '').toLowerCase() === 'delete' ? [] : [String(request?.title || request?.kind || 'agent-tool').slice(0, 1024)];")
replace('src/runtime/tool-runtime.mjs',
"    projectBound ? 'This session is project-bound; workspace tools are available through the runtime permission boundary.' : 'This is a general chat; filesystem and shell tools are unavailable.',",
"    projectBound ? 'This session is project-bound; workspace tools are available through the runtime permission boundary. Never delete paths outside the active project root.' : 'This is a general chat; filesystem and shell tools are unavailable.',")

# Runtime permission broker: Default / Auto / Full access.
replace('src/runtime/permissions.mjs',
"  #emit; #interactive; #pending = new Map(); #autoSessions = new Set(); #always = new Map();",
"  #emit; #interactive; #pending = new Map(); #autoSessions = new Set(); #fullSessions = new Set(); #always = new Map();")
replace('src/runtime/permissions.mjs',
"  autoStatus(sessionId) { return { sessionId, enabled: this.#autoSessions.has(sessionId) }; }\n  setAuto(sessionId, enabled) {\n    if (!sessionId) throw new Error('sessionId is required');\n    if (enabled) this.#autoSessions.add(sessionId); else this.#autoSessions.delete(sessionId);\n    return this.autoStatus(sessionId);\n  }",
"  autoStatus(sessionId) {\n    const fullAccess = this.#fullSessions.has(sessionId);\n    const enabled = this.#autoSessions.has(sessionId);\n    return { sessionId, enabled, fullAccess, mode: fullAccess ? 'full' : enabled ? 'auto' : 'default' };\n  }\n  setAuto(sessionId, enabled) {\n    if (!sessionId) throw new Error('sessionId is required');\n    if (enabled === 'full') {\n      this.#fullSessions.add(sessionId);\n      this.#autoSessions.delete(sessionId);\n    } else if (enabled) {\n      this.#autoSessions.add(sessionId);\n      this.#fullSessions.delete(sessionId);\n    } else {\n      this.#autoSessions.delete(sessionId);\n      this.#fullSessions.delete(sessionId);\n    }\n    return this.autoStatus(sessionId);\n  }")
replace('src/runtime/permissions.mjs',
"    const removedAuto = this.#autoSessions.delete(sessionId);\n    const removedAlways = this.#always.delete(sessionId);\n    let forgotten = removedAuto || removedAlways;",
"    const removedAuto = this.#autoSessions.delete(sessionId);\n    const removedFull = this.#fullSessions.delete(sessionId);\n    const removedAlways = this.#always.delete(sessionId);\n    let forgotten = removedAuto || removedFull || removedAlways;")
replace('src/runtime/permissions.mjs',
"    const immediate = await immediateDecision({ action, resources: normalized, projectRoot, planMode, auto: this.#autoSessions.has(sessionId) });",
"    const immediate = await immediateDecision({ action, resources: normalized, projectRoot, planMode, auto: this.#autoSessions.has(sessionId), fullAccess: this.#fullSessions.has(sessionId) });")
replace('src/runtime/permissions.mjs',
"async function immediateDecision({ action, resources, projectRoot, planMode, auto }) {",
"async function immediateDecision({ action, resources, projectRoot, planMode, auto, fullAccess }) {")
replace('src/runtime/permissions.mjs',
"  if (planMode && ['edit', 'write', 'bash'].includes(action)) return { effect: 'deny', code: 'plan_mode_read_only', reason: 'Plan mode is read-only; mutating tools and arbitrary shell commands are blocked.' };\n\n  if (WORKSPACE_ACTIONS.has(action)) {",
"  if (planMode && ['edit', 'write', 'delete', 'bash'].includes(action)) return { effect: 'deny', code: 'plan_mode_read_only', reason: 'Plan mode is read-only; mutating tools and arbitrary shell commands are blocked.' };\n\n  if (fullAccess) {\n    if (!projectRoot && (WORKSPACE_ACTIONS.has(action) || action === 'delete' || action === 'bash')) {\n      return { effect: 'deny', code: 'project_required', reason: 'Full access filesystem and shell actions require a project-bound session.' };\n    }\n    if (action === 'delete') {\n      if (!resources.length) return { effect: 'deny', code: 'full_access_delete_unverified', reason: 'Full access blocked a delete because its target path could not be verified inside the active project.' };\n      const inside = await Promise.all(resources.map((resource) => isDeleteTargetInsideProject(resource, projectRoot)));\n      if (!inside.every(Boolean)) return { effect: 'deny', code: 'full_access_delete_outside_project', reason: 'Full access never permits deletion outside the active project root.' };\n      return { effect: 'allow', source: 'session-full-access' };\n    }\n    if (action === 'bash') {\n      const command = resources[0] ?? '';\n      const deletion = await inspectFullAccessDeletion(command, projectRoot);\n      if (!deletion.allowed) return { effect: 'deny', code: deletion.code, reason: deletion.reason };\n      return { effect: 'allow', source: 'session-full-access' };\n    }\n    return { effect: 'allow', source: 'session-full-access' };\n  }\n\n  if (WORKSPACE_ACTIONS.has(action)) {")

marker = "export function isSafeAutoBashCommand(command) {"
helper = r'''export async function inspectFullAccessDeletion(command, projectRoot) {
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

'''
p = Path('src/runtime/permissions.mjs')
text = p.read_text()
if text.count(marker) != 1:
    raise SystemExit('permissions.mjs: safe bash marker missing/duplicated')
p.write_text(text.replace(marker, helper + marker, 1))

Path('test/full-access-permissions.test.mjs').write_text(r'''import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PermissionBroker, PermissionDeniedError, inspectFullAccessDeletion } from '../src/runtime/permissions.mjs';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-full-access-'));
  const root = join(dir, 'project');
  const outside = join(dir, 'outside');
  await mkdir(join(root, 'src', 'tmp'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, '.env'), 'SECRET=1\n');
  await writeFile(join(outside, 'secret.txt'), 'outside\n');
  await symlink(outside, join(root, 'escape'));
  return { dir, root, outside };
}

test('full access removes permission prompts for project actions', async () => {
  const { dir, root } = await fixture();
  const broker = new PermissionBroker();
  try {
    assert.deepEqual(broker.setAuto('s1', 'full'), { sessionId: 's1', enabled: false, fullAccess: true, mode: 'full' });
    assert.deepEqual(await broker.authorize({ sessionId: 's1', action: 'read', resources: ['.env'], projectRoot: root }), { allowed: true, source: 'session-full-access' });
    assert.deepEqual(await broker.authorize({ sessionId: 's1', action: 'edit', resources: ['../outside/secret.txt'], projectRoot: root }), { allowed: true, source: 'session-full-access' });
    assert.deepEqual(await broker.authorize({ sessionId: 's1', action: 'browser-control', resources: ['browser_click'], projectRoot: root }), { allowed: true, source: 'session-full-access' });
    assert.deepEqual(await broker.authorize({ sessionId: 's1', action: 'bash', resources: ['npm test'], projectRoot: root }), { allowed: true, source: 'session-full-access' });
    assert.equal(broker.list('s1').length, 0);
  } finally { broker.close(); await rm(dir, { recursive: true, force: true }); }
});

test('full access allows in-project deletion and blocks outside or unverifiable deletion', async () => {
  const { dir, root, outside } = await fixture();
  const broker = new PermissionBroker();
  broker.setAuto('s1', 'full');
  try {
    for (const command of [
      'rm -rf src/tmp',
      'rm -rf ./src/*',
      'find src -name "*.tmp" -delete',
      'bash -c "rm -rf src/generated"',
      'git clean -fd',
    ]) {
      assert.deepEqual(await broker.authorize({ sessionId: 's1', action: 'bash', resources: [command], projectRoot: root }), { allowed: true, source: 'session-full-access' }, command);
    }
    for (const command of [
      'rm -rf ../outside',
      `rm -rf ${outside}`,
      'find ../outside -delete',
      `bash -c "rm -rf ${outside}"`,
      `git -C ${outside} clean -fd`,
      'rm -rf "$HOME/unsafe"',
      'rm -rf escape/secret.txt',
    ]) {
      await assert.rejects(
        broker.authorize({ sessionId: 's1', action: 'bash', resources: [command], projectRoot: root }),
        (error) => error instanceof PermissionDeniedError && ['full_access_delete_outside_project', 'full_access_delete_unverified'].includes(error.code),
        command,
      );
    }
    assert.equal((await inspectFullAccessDeletion('echo hello', root)).allowed, true);
  } finally { broker.close(); await rm(dir, { recursive: true, force: true }); }
});

test('ACP-style delete permissions must name targets inside the project', async () => {
  const { dir, root } = await fixture();
  const broker = new PermissionBroker();
  broker.setAuto('s1', 'full');
  try {
    assert.deepEqual(await broker.authorize({ sessionId: 's1', action: 'delete', resources: ['src/tmp'], projectRoot: root }), { allowed: true, source: 'session-full-access' });
    await assert.rejects(
      broker.authorize({ sessionId: 's1', action: 'delete', resources: ['../outside'], projectRoot: root }),
      (error) => error instanceof PermissionDeniedError && error.code === 'full_access_delete_outside_project',
    );
    await assert.rejects(
      broker.authorize({ sessionId: 's1', action: 'delete', resources: [], projectRoot: root }),
      (error) => error instanceof PermissionDeniedError && error.code === 'full_access_delete_unverified',
    );
  } finally { broker.close(); await rm(dir, { recursive: true, force: true }); }
});

test('plan mode remains read-only even when full access is selected', async () => {
  const { dir, root } = await fixture();
  const broker = new PermissionBroker();
  broker.setAuto('s1', 'full');
  try {
    await assert.rejects(
      broker.authorize({ sessionId: 's1', action: 'bash', resources: ['npm test'], projectRoot: root, planMode: true }),
      (error) => error instanceof PermissionDeniedError && error.code === 'plan_mode_read_only',
    );
    await assert.rejects(
      broker.authorize({ sessionId: 's1', action: 'delete', resources: ['src/tmp'], projectRoot: root, planMode: true }),
      (error) => error instanceof PermissionDeniedError && error.code === 'plan_mode_read_only',
    );
  } finally { broker.close(); await rm(dir, { recursive: true, force: true }); }
});
''')
