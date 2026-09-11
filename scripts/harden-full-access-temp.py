from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    text = p.read_text()
    actual = text.count(old)
    if actual != count:
        raise SystemExit(f"{path}: expected {count} occurrence(s), found {actual}: {old[:160]!r}")
    p.write_text(text.replace(old, new, count))


# ACP/local-agent permission requests must carry the actual terminal command so
# the Full access deletion boundary can inspect it, and web-fetch requests get
# a stable action class for Auto mode.
replace(
    'src/runtime/tool-runtime.mjs',
    "            action: agentPermissionAction(request?.kind),",
    "            action: agentPermissionAction(request?.kind, request?.title),",
)
replace(
    'src/runtime/tool-runtime.mjs',
    "function agentPermissionAction(kind) {\n  const value = String(kind ?? '').toLowerCase();\n  if (['read', 'search'].includes(value)) return 'read';\n  if (value === 'delete') return 'delete';\n  if (['edit', 'move', 'write'].includes(value)) return 'edit';\n  if (['execute', 'terminal'].includes(value)) return 'bash';\n  return 'agent-tool';\n}",
    "export function agentPermissionAction(kind, title = '') {\n  const value = String(kind ?? '').trim().toLowerCase().replace(/[ _]+/g, '-');\n  const hint = `${value} ${String(title ?? '').toLowerCase()}`;\n  if (value === 'read') return 'read';\n  if (value === 'search') return /\\b(web|browser|url|https?)\\b/.test(hint) ? 'web-fetch' : 'read';\n  if (['fetch', 'web-fetch', 'web-search', 'browse', 'browser-fetch', 'url-fetch', 'http-fetch'].includes(value)) return 'web-fetch';\n  if (/\\b(web|browser|url|https?)\\b/.test(hint) && /\\b(fetch|search|browse|open|get|read)\\b/.test(hint)) return 'web-fetch';\n  if (value === 'delete') return 'delete';\n  if (['edit', 'move', 'write'].includes(value)) return 'edit';\n  if (['execute', 'terminal'].includes(value)) return 'bash';\n  return 'agent-tool';\n}",
)
replace(
    'src/runtime/tool-runtime.mjs',
    "function agentPermissionResources(request) {\n  const locations = Array.isArray(request?.locations) ? request.locations : [];\n  const paths = locations.flatMap((item) => typeof item?.path === 'string' && item.path.trim() ? [item.path.trim().slice(0, 1024)] : []);\n  if (paths.length) return paths.slice(0, 16);\n  return String(request?.kind ?? '').toLowerCase() === 'delete' ? [] : [String(request?.title || request?.kind || 'agent-tool').slice(0, 1024)];\n}",
    "export function agentPermissionResources(request) {\n  const kind = String(request?.kind ?? '').toLowerCase();\n  if (['execute', 'terminal'].includes(kind)) {\n    const command = agentPermissionCommand(request?.rawInput);\n    if (command) return [command.slice(0, 1024)];\n  }\n  const locations = Array.isArray(request?.locations) ? request.locations : [];\n  const paths = locations.flatMap((item) => typeof item?.path === 'string' && item.path.trim() ? [item.path.trim().slice(0, 1024)] : []);\n  if (paths.length) return paths.slice(0, 16);\n  return kind === 'delete' ? [] : [String(request?.title || request?.kind || 'agent-tool').slice(0, 1024)];\n}\nfunction agentPermissionCommand(rawInput, depth = 0) {\n  if (depth > 3 || rawInput == null) return '';\n  if (typeof rawInput === 'string') return rawInput.trim();\n  if (Array.isArray(rawInput)) {\n    if (rawInput.every((item) => ['string', 'number', 'boolean'].includes(typeof item))) return rawInput.map(String).join(' ').trim();\n    for (const item of rawInput) {\n      const nested = agentPermissionCommand(item, depth + 1);\n      if (nested) return nested;\n    }\n    return '';\n  }\n  if (typeof rawInput !== 'object') return '';\n  for (const key of ['command', 'cmd', 'shellCommand', 'script']) {\n    const value = rawInput[key];\n    if (typeof value === 'string' && value.trim()) {\n      const args = Array.isArray(rawInput.args) ? rawInput.args.map(String) : [];\n      return [value.trim(), ...args].join(' ').trim();\n    }\n    const nested = agentPermissionCommand(value, depth + 1);\n    if (nested) return nested;\n  }\n  for (const key of ['input', 'arguments', 'params', 'toolInput']) {\n    const nested = agentPermissionCommand(rawInput[key], depth + 1);\n    if (nested) return nested;\n  }\n  return '';\n}",
)

# Auto mode is intentionally broader than before: provider web-fetch actions,
# project-scoped file/delete/agent requests, and shell commands that remain
# project-scoped are approved without prompting. Full access remains broader,
# with only the hard outside-project deletion boundary retained.
replace(
    'src/runtime/permissions.mjs',
    "const WORKSPACE_ACTIONS = new Set(['read', 'edit', 'write']);",
    "const WORKSPACE_ACTIONS = new Set(['read', 'edit', 'write']);\nconst AUTO_PROJECT_ACTIONS = new Set(['delete', 'agent-tool']);",
)
replace(
    'src/runtime/permissions.mjs',
    "  if (planMode && ['edit', 'write', 'delete', 'bash'].includes(action)) return { effect: 'deny', code: 'plan_mode_read_only', reason: 'Plan mode is read-only; mutating tools and arbitrary shell commands are blocked.' };\n\n  if (fullAccess) {",
    "  if (planMode && ['edit', 'write', 'delete', 'bash'].includes(action)) return { effect: 'deny', code: 'plan_mode_read_only', reason: 'Plan mode is read-only; mutating tools and arbitrary shell commands are blocked.' };\n  if (auto && action === 'web-fetch') return { effect: 'allow', source: 'session-auto-web' };\n\n  if (fullAccess) {",
)
replace(
    'src/runtime/permissions.mjs',
    "    const envExample = resources.length > 0 && resources.every(isEnvExampleResource);\n    const safe = resources.length > 0 && (await Promise.all(resources.map((resource) => isSafeWorkspaceResource(resource, projectRoot)))).every(Boolean);\n\n    if (action === 'read' && process.env.CUPPET_GRAPH_FIRST_GATE !== '1' && (safe || envExample)) {\n      return { effect: 'allow', source: 'workspace-read' };\n    }\n    if (auto && safe) return { effect: 'allow', source: 'session-auto' };\n    return { effect: 'ask', autoEligible: safe };\n  }\n\n  if (action === 'bash') return { effect: 'ask', autoEligible: false };",
    "    const envExample = resources.length > 0 && resources.every(isEnvExampleResource);\n    const safe = resources.length > 0 && (await Promise.all(resources.map((resource) => isSafeWorkspaceResource(resource, projectRoot)))).every(Boolean);\n    const projectScoped = resources.length > 0 && (await Promise.all(resources.map((resource) => isProjectScopedResource(resource, projectRoot)))).every(Boolean);\n\n    if (action === 'read' && process.env.CUPPET_GRAPH_FIRST_GATE !== '1' && (safe || envExample)) {\n      return { effect: 'allow', source: 'workspace-read' };\n    }\n    if (auto && projectScoped) return { effect: 'allow', source: 'session-auto-project' };\n    return { effect: 'ask', autoEligible: auto ? projectScoped : safe };\n  }\n\n  if (auto && AUTO_PROJECT_ACTIONS.has(action)) {\n    if (!projectRoot || !resources.length) return { effect: 'ask', autoEligible: false };\n    if (resources.some((resource) => isProtectedResource(resource))) return { effect: 'deny', code: 'protected_resource', reason: 'Cuppet protected runtime/credential files cannot be accessed by the coding model.' };\n    const projectScoped = (await Promise.all(resources.map((resource) => isProjectScopedResource(resource, projectRoot)))).every(Boolean);\n    if (projectScoped) return { effect: 'allow', source: 'session-auto-project' };\n    return { effect: 'ask', autoEligible: false };\n  }\n\n  if (action === 'bash') {\n    if (auto && projectRoot && resources.length === 1 && await isAutoProjectBashCommand(resources[0], projectRoot)) return { effect: 'allow', source: 'session-auto-project' };\n    return { effect: 'ask', autoEligible: false };\n  }",
)
replace(
    'src/runtime/permissions.mjs',
    "export async function isSafeWorkspaceResource(resource, workspaceRoot) {",
    "export async function isProjectScopedResource(resource, workspaceRoot) {\n  if (!resource || resource.trim() !== resource || resource.includes('\\0') || resource.startsWith('~') || resource.startsWith('file:') || UNSAFE_RESOURCE_CHARACTERS.test(resource)) return false;\n  const root = await realpath(workspaceRoot).catch(() => resolve(workspaceRoot));\n  const candidate = isAbsolute(resource) ? resolve(resource) : resolve(root, resource);\n  if (!isAtOrInside(root, candidate)) return false;\n  return nearestExistingAncestorIsInside(candidate, root);\n}\n\nexport async function isAutoProjectBashCommand(command, projectRoot) {\n  const source = String(command ?? '').trim();\n  if (!source || !projectRoot || source.length > 8000) return false;\n  const deletion = await inspectFullAccessDeletion(source, projectRoot);\n  if (!deletion.allowed) return false;\n  if (/(^|[\\s\"'=])(?:~(?:[\\/]|$)|\\.\\.(?:[\\/]|$)|file:)/i.test(source)) return false;\n  if (/`|\\$\\(/.test(source)) return false;\n  if (/\\$(?:[A-Za-z_][A-Za-z0-9_]*|\\{[^}]+\\})(?:[\\/]|$)|%USERPROFILE%/i.test(source)) return false;\n\n  const withoutUrls = source.replace(/\\b[a-z][a-z0-9+.-]*:\\/\\/[^\\s\"'`]+/gi, '');\n  const candidates = [];\n  for (const match of withoutUrls.matchAll(/(^|[\\s\"'=])(\\/[^\\s\"'`;|&<>]*)/g)) if (match[2]) candidates.push(match[2]);\n  for (const match of withoutUrls.matchAll(/(^|[\\s\"'=])([A-Za-z]:[\\\\/][^\\s\"'`;|&<>]*)/g)) if (match[2]) candidates.push(match[2]);\n  for (const candidate of candidates) if (!(await isProjectScopedResource(candidate, projectRoot))) return false;\n  return true;\n}\n\nexport async function isSafeWorkspaceResource(resource, workspaceRoot) {",
)

replace(
    'src/renderer/react/GeneralPanel.tsx',
    "<div><strong>Permissions</strong><span>Default asks before protected actions. Auto approves eligible project actions. Full access removes permission prompts in project chats, while destructive deletion outside the active project stays blocked.</span></div>",
    "<div><strong>Permissions</strong><span>Default asks before protected actions. Auto approves web fetches and actions scoped to the active project. Full access removes permission prompts in project chats, while destructive deletion outside the active project stays blocked.</span></div>",
)

p = Path('test/full-access-permissions.test.mjs')
text = p.read_text()
needle = "import { PermissionBroker, PermissionDeniedError, inspectFullAccessDeletion } from '../src/runtime/permissions.mjs';\n"
if text.count(needle) != 1:
    raise SystemExit('full access test import marker missing')
text = text.replace(
    needle,
    "import { PermissionBroker, PermissionDeniedError, inspectFullAccessDeletion } from '../src/runtime/permissions.mjs';\nimport { agentPermissionAction, agentPermissionResources } from '../src/runtime/tool-runtime.mjs';\n",
    1,
)
text += r'''

test('ACP native terminal/delete permission requests feed the Full access delete boundary', () => {
  assert.equal(agentPermissionAction('delete'), 'delete');
  assert.equal(agentPermissionAction('execute'), 'bash');
  assert.equal(agentPermissionAction('fetch'), 'web-fetch');
  assert.equal(agentPermissionAction('search', 'Search the web'), 'web-fetch');
  assert.deepEqual(
    agentPermissionResources({ kind: 'execute', title: 'Run command', rawInput: { command: 'rm', args: ['-rf', '../outside'] } }),
    ['rm -rf ../outside'],
  );
  assert.deepEqual(
    agentPermissionResources({ kind: 'terminal', rawInput: { toolInput: { shellCommand: 'find ../outside -delete' } } }),
    ['find ../outside -delete'],
  );
  assert.deepEqual(agentPermissionResources({ kind: 'delete', title: 'Delete something', locations: [] }), []);
});

test('auto mode approves web fetches and project-scoped actions but not obvious escapes', async () => {
  const { dir, root } = await fixture();
  const broker = new PermissionBroker({ interactive: false });
  broker.setAuto('s1', true);
  try {
    assert.deepEqual(
      await broker.authorize({ sessionId: 's1', action: 'web-fetch', resources: ['https://example.com/data'], projectRoot: root }),
      { allowed: true, source: 'session-auto-web' },
    );
    assert.deepEqual(
      await broker.authorize({ sessionId: 's1', action: 'read', resources: ['.env'], projectRoot: root }),
      { allowed: true, source: 'session-auto-project' },
    );
    assert.deepEqual(
      await broker.authorize({ sessionId: 's1', action: 'edit', resources: ['.'], projectRoot: root }),
      { allowed: true, source: 'session-auto-project' },
    );
    assert.deepEqual(
      await broker.authorize({ sessionId: 's1', action: 'delete', resources: ['src/tmp'], projectRoot: root }),
      { allowed: true, source: 'session-auto-project' },
    );
    assert.deepEqual(
      await broker.authorize({ sessionId: 's1', action: 'agent-tool', resources: ['src'], projectRoot: root }),
      { allowed: true, source: 'session-auto-project' },
    );
    assert.deepEqual(
      await broker.authorize({ sessionId: 's1', action: 'bash', resources: ['npm test'], projectRoot: root }),
      { allowed: true, source: 'session-auto-project' },
    );
    assert.deepEqual(
      await broker.authorize({ sessionId: 's1', action: 'bash', resources: ['curl https://example.com/data'], projectRoot: root }),
      { allowed: true, source: 'session-auto-project' },
    );
    await assert.rejects(
      broker.authorize({ sessionId: 's1', action: 'edit', resources: ['../outside/secret.txt'], projectRoot: root }),
      (error) => error instanceof PermissionDeniedError && error.code === 'interaction_required',
    );
    await assert.rejects(
      broker.authorize({ sessionId: 's1', action: 'bash', resources: ['rm -rf ../outside'], projectRoot: root }),
      (error) => error instanceof PermissionDeniedError && error.code === 'interaction_required',
    );
    await assert.rejects(
      broker.authorize({ sessionId: 's1', action: 'read', resources: ['.cuppet/credentials.json'], projectRoot: root }),
      (error) => error instanceof PermissionDeniedError && error.code === 'protected_resource',
    );
  } finally { broker.close(); await rm(dir, { recursive: true, force: true }); }
});
'''
p.write_text(text)
