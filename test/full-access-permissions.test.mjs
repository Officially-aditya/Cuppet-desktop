import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PermissionBroker, PermissionDeniedError, inspectFullAccessDeletion } from '../src/runtime/permissions.mjs';
import { agentPermissionAction, agentPermissionResources, runShell } from '../src/runtime/tool-runtime.mjs';

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
    await assert.rejects(
      broker.authorize({ sessionId: 's1', action: 'browser-control', resources: ['browser_click'], projectRoot: root, planMode: true }),
      (error) => error instanceof PermissionDeniedError && error.code === 'plan_mode_read_only',
    );
    await assert.rejects(
      broker.authorize({ sessionId: 's1', action: 'agent-tool', resources: ['opaque-side-effect'], projectRoot: root, planMode: true }),
      (error) => error instanceof PermissionDeniedError && error.code === 'plan_mode_read_only',
    );
  } finally { broker.close(); await rm(dir, { recursive: true, force: true }); }
});



test('macOS Full access shell blocks indirect deletion outside the project at the syscall boundary', { skip: process.platform !== 'darwin' }, async () => {
  const { dir, root, outside } = await fixture();
  const outsideFile = join(outside, 'secret.txt');
  const insideFile = join(root, 'src', 'tmp', 'inside.txt');
  const commandFor = (source) => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
  try {
    await writeFile(insideFile, 'inside\n');

    const outsideWrite = await runShell(
      commandFor(`require('node:fs').writeFileSync(${JSON.stringify(outsideFile)}, 'changed\\n')`),
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
    assert.equal(await readFile(outsideFile, 'utf8'), 'changed\n');

    const symlinkDelete = await runShell(
      commandFor(`require('node:fs').rmSync(${JSON.stringify(join(root, 'escape', 'secret.txt'))})`),
      root,
      10_000,
      undefined,
      { fullAccess: true },
    );
    assert.notEqual(symlinkDelete.code, 0, 'symlink escape unlink unexpectedly succeeded');
    assert.equal(await readFile(outsideFile, 'utf8'), 'changed\n');

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
      { allowed: true, source: 'session-auto' },
    );
    assert.deepEqual(
      await broker.authorize({ sessionId: 's1', action: 'edit', resources: ['.'], projectRoot: root }),
      { allowed: true, source: 'session-auto' },
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
