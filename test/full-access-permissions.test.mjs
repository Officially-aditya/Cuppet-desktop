import test from 'node:test';
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
