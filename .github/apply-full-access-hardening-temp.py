from pathlib import Path


def replace_once(path, old, new):
    file = Path(path)
    source = file.read_text()
    if old not in source:
        raise SystemExit(f"missing anchor in {path}: {old[:100]!r}")
    file.write_text(source.replace(old, new, 1))


replace_once(
    "src/runtime/permissions.mjs",
    "const AUTO_PROJECT_ACTIONS = new Set(['delete', 'agent-tool']);\n",
    "const AUTO_PROJECT_ACTIONS = new Set(['delete', 'agent-tool']);\nconst PLAN_MUTATING_ACTIONS = new Set(['edit', 'write', 'delete', 'bash', 'browser-control', 'agent-tool']);\n",
)
replace_once(
    "src/runtime/permissions.mjs",
    "  if (planMode && ['edit', 'write', 'delete', 'bash'].includes(action)) return { effect: 'deny', code: 'plan_mode_read_only', reason: 'Plan mode is read-only; mutating tools and arbitrary shell commands are blocked.' };\n",
    "  if (planMode && PLAN_MUTATING_ACTIONS.has(action)) return { effect: 'deny', code: 'plan_mode_read_only', reason: 'Plan mode is read-only; mutating tools, browser control, agent side effects, and arbitrary shell commands are blocked.' };\n",
)

replace_once(
    "src/runtime/tool-runtime.mjs",
    "      await authorize({ action: 'bash', resources: [command], description: `Run validation check in project: ${command.slice(0, 300)}` });\n      const executed = await runShell(command, projectRoot, clamp(Number(args.timeout_ms) || 60000, 1000, 120000), signal);\n",
    "      const permission = await authorize({ action: 'bash', resources: [command], description: `Run validation check in project: ${command.slice(0, 300)}` });\n      const executed = await runShell(command, projectRoot, clamp(Number(args.timeout_ms) || 60000, 1000, 120000), signal, { fullAccess: permission.source === 'session-full-access' });\n",
)
replace_once(
    "src/runtime/tool-runtime.mjs",
    "    await authorize({ action: 'bash', resources: [command], description: `Run shell command in project: ${command.slice(0, 300)}` });\n    const timeoutMs = clamp(Number(args.timeout_ms) || 30000, 1000, 120000);\n    const executed = await runShell(command, projectRoot, timeoutMs, signal);\n",
    "    const permission = await authorize({ action: 'bash', resources: [command], description: `Run shell command in project: ${command.slice(0, 300)}` });\n    const timeoutMs = clamp(Number(args.timeout_ms) || 30000, 1000, 120000);\n    const executed = await runShell(command, projectRoot, timeoutMs, signal, { fullAccess: permission.source === 'session-full-access' });\n",
)
replace_once(
    "src/runtime/tool-runtime.mjs",
    "function runShell(command, cwd, timeoutMs, signal) {\n  return new Promise((resolvePromise, reject) => {\n    const child = spawn(command, { cwd, shell: true, env: safeShellEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });\n",
    "export async function runShell(command, cwd, timeoutMs, signal, { fullAccess = false } = {}) {\n  const spawnSpec = await shellSpawnSpec(command, cwd, fullAccess);\n  return new Promise((resolvePromise, reject) => {\n    const child = spawn(spawnSpec.command, spawnSpec.args, { cwd, shell: spawnSpec.shell, env: safeShellEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });\n",
)
replace_once(
    "src/runtime/tool-runtime.mjs",
    "}\nfunction safeShellEnvironment() {\n",
    """}
async function shellSpawnSpec(command, cwd, fullAccess) {
  if (!fullAccess || process.platform !== 'darwin') return { command, args: [], shell: true };
  return {
    command: '/usr/bin/sandbox-exec',
    args: ['-p', await fullAccessMacSandboxProfile(cwd), '/bin/sh', '-lc', command],
    shell: false,
  };
}
export async function fullAccessMacSandboxProfile(projectRoot) {
  const root = await realpath(projectRoot).catch(() => resolve(projectRoot));
  const literal = JSON.stringify(root);
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write-unlink)',
    `(allow file-write-unlink (literal ${literal}))`,
    `(allow file-write-unlink (subpath ${literal}))`,
  ].join('\\n');
}
function safeShellEnvironment() {
""",
)
replace_once(
    "src/runtime/tool-runtime.mjs",
    "    mode === 'plan' ? 'Plan mode is read-only: tst_edit_batch may prepare/inspect but apply, generic writes, and arbitrary shell execution are blocked.' : '',\n",
    "    mode === 'plan' ? 'Plan mode is read-only: tst_edit_batch may prepare/inspect, but apply, generic writes, arbitrary shell execution, browser mutations, and agent side effects are blocked.' : '',\n",
)

replace_once(
    "test/full-access-permissions.test.mjs",
    "import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';\n",
    "import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';\n",
)
replace_once(
    "test/full-access-permissions.test.mjs",
    "import { agentPermissionAction, agentPermissionResources } from '../src/runtime/tool-runtime.mjs';\n",
    "import { agentPermissionAction, agentPermissionResources, runShell } from '../src/runtime/tool-runtime.mjs';\n",
)
replace_once(
    "test/full-access-permissions.test.mjs",
    """    await assert.rejects(
      broker.authorize({ sessionId: 's1', action: 'delete', resources: ['src/tmp'], projectRoot: root, planMode: true }),
      (error) => error instanceof PermissionDeniedError && error.code === 'plan_mode_read_only',
    );
""",
    """    await assert.rejects(
      broker.authorize({ sessionId: 's1', action: 'delete', resources: ['src/tmp'], projectRoot: root, planMode: true }),
      (error) => error instanceof PermissionDeniedError && error.code === 'plan_mode_read_only',
    );
    await assert.rejects(
      broker.authorize({ sessionId: 's1', action: 'browser-control', resources: ['browser_click'], projectRoot: root, planMode: true }),
      (error) => error instanceof PermissionDeniedError && error.code === 'plan_mode_read_only',
    );
    await assert.rejects(
      broker.authorize({ sessionId: 's1', action: 'agent-tool', resources: ['opaque-side-effect'], projectRoot: root, planMode: true }),
      (error) => error instanceof PermissionDeniedError && error.code === 'plan_mode_read_only',
    );
""",
)

marker = "\n\ntest('ACP native terminal/delete permission requests feed the Full access delete boundary', () => {\n"
integration = """
test('macOS Full access shell blocks indirect deletion outside the project at the syscall boundary', { skip: process.platform !== 'darwin' }, async () => {
  const { dir, root, outside } = await fixture();
  const outsideFile = join(outside, 'secret.txt');
  const insideFile = join(root, 'src', 'tmp', 'inside.txt');
  const commandFor = (source) => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
  try {
    await writeFile(insideFile, 'inside\\n');

    const outsideWrite = await runShell(
      commandFor(`require('node:fs').writeFileSync(${JSON.stringify(outsideFile)}, 'changed\\\\n')`),
      root,
      10_000,
      undefined,
      { fullAccess: true },
    );
    assert.equal(outsideWrite.code, 0, outsideWrite.stderr);

    const outsideDelete = await runShell(
      commandFor(`require('node:fs').rmSync(${JSON.stringify(outsideFile)})`),
      root,
      10_000,
      undefined,
      { fullAccess: true },
    );
    assert.notEqual(outsideDelete.code, 0, 'outside-project unlink unexpectedly succeeded');
    assert.equal(await readFile(outsideFile, 'utf8'), 'changed\\n');

    const symlinkDelete = await runShell(
      commandFor(`require('node:fs').rmSync(${JSON.stringify(join(root, 'escape', 'secret.txt'))})`),
      root,
      10_000,
      undefined,
      { fullAccess: true },
    );
    assert.notEqual(symlinkDelete.code, 0, 'symlink escape unlink unexpectedly succeeded');
    assert.equal(await readFile(outsideFile, 'utf8'), 'changed\\n');

    const insideDelete = await runShell(
      commandFor(`require('node:fs').rmSync(${JSON.stringify(insideFile)})`),
      root,
      10_000,
      undefined,
      { fullAccess: true },
    );
    assert.equal(insideDelete.code, 0, insideDelete.stderr);
    await assert.rejects(readFile(insideFile, 'utf8'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
"""
file = Path("test/full-access-permissions.test.mjs")
source = file.read_text()
if marker not in source:
    raise SystemExit("ACP marker missing")
file.write_text(source.replace(marker, "\n\n" + integration + marker, 1))

print("Full access hardening patch applied.")
