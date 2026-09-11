from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    text = p.read_text()
    actual = text.count(old)
    if actual != count:
        raise SystemExit(f"{path}: expected {count} occurrence(s), found {actual}: {old[:120]!r}")
    p.write_text(text.replace(old, new, count))


replace('src/runtime/tool-runtime.mjs',
"function agentPermissionAction(kind) {",
"export function agentPermissionAction(kind) {")
replace('src/runtime/tool-runtime.mjs',
"function agentPermissionResources(request) {\n  const locations = Array.isArray(request?.locations) ? request.locations : [];\n  const paths = locations.flatMap((item) => typeof item?.path === 'string' && item.path.trim() ? [item.path.trim().slice(0, 1024)] : []);\n  if (paths.length) return paths.slice(0, 16);\n  return String(request?.kind ?? '').toLowerCase() === 'delete' ? [] : [String(request?.title || request?.kind || 'agent-tool').slice(0, 1024)];\n}",
"export function agentPermissionResources(request) {\n  const kind = String(request?.kind ?? '').toLowerCase();\n  if (['execute', 'terminal'].includes(kind)) {\n    const command = agentPermissionCommand(request?.rawInput);\n    if (command) return [command.slice(0, 1024)];\n  }\n  const locations = Array.isArray(request?.locations) ? request.locations : [];\n  const paths = locations.flatMap((item) => typeof item?.path === 'string' && item.path.trim() ? [item.path.trim().slice(0, 1024)] : []);\n  if (paths.length) return paths.slice(0, 16);\n  return kind === 'delete' ? [] : [String(request?.title || request?.kind || 'agent-tool').slice(0, 1024)];\n}\nfunction agentPermissionCommand(rawInput, depth = 0) {\n  if (depth > 3 || rawInput == null) return '';\n  if (typeof rawInput === 'string') return rawInput.trim();\n  if (Array.isArray(rawInput)) {\n    if (rawInput.every((item) => ['string', 'number', 'boolean'].includes(typeof item))) return rawInput.map(String).join(' ').trim();\n    for (const item of rawInput) {\n      const nested = agentPermissionCommand(item, depth + 1);\n      if (nested) return nested;\n    }\n    return '';\n  }\n  if (typeof rawInput !== 'object') return '';\n  for (const key of ['command', 'cmd', 'shellCommand', 'script']) {\n    const value = rawInput[key];\n    if (typeof value === 'string' && value.trim()) {\n      const args = Array.isArray(rawInput.args) ? rawInput.args.map(String) : [];\n      return [value.trim(), ...args].join(' ').trim();\n    }\n    const nested = agentPermissionCommand(value, depth + 1);\n    if (nested) return nested;\n  }\n  for (const key of ['input', 'arguments', 'params', 'toolInput']) {\n    const nested = agentPermissionCommand(rawInput[key], depth + 1);\n    if (nested) return nested;\n  }\n  return '';\n}")

p = Path('test/full-access-permissions.test.mjs')
text = p.read_text()
needle = "import { PermissionBroker, PermissionDeniedError, inspectFullAccessDeletion } from '../src/runtime/permissions.mjs';\n"
if text.count(needle) != 1:
    raise SystemExit('full access test import marker missing')
text = text.replace(needle, needle + "import { agentPermissionAction, agentPermissionResources } from '../src/runtime/tool-runtime.mjs';\n", 1)
text += r'''

test('ACP native terminal/delete permission requests feed the Full access delete boundary', () => {
  assert.equal(agentPermissionAction('delete'), 'delete');
  assert.equal(agentPermissionAction('execute'), 'bash');
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
'''
p.write_text(text)
