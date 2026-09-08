import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PermissionBroker, PermissionDeniedError, isSafeAutoBashCommand, isSafeWorkspaceResource } from '../src/runtime/permissions.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-c1-permissions-'));
  const root = join(dir, 'project');
  const outside = join(dir, 'outside');
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, '.cuppet'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, 'src', 'app.js'), 'export const value = 1;\n');
  await writeFile(join(root, '.env'), 'SECRET=1\n');
  await writeFile(join(root, '.env.example'), 'SECRET=example\n');
  await writeFile(join(root, '.cuppet', 'credentials.json'), '{}\n');
  await writeFile(join(outside, 'secret.txt'), 'outside\n');
  await symlink(outside, join(root, 'escape'));
  return { dir, root };
}

test('safe bash classifier only accepts the pinned metadata-only command family', () => {
  for (const command of [
    'pwd',
    'ls',
    'ls -lah',
    'git status --short',
    'git log --oneline -1',
    'git branch --show-current',
    'git ls-files --cached',
    'git rev-parse --show-toplevel',
    'node --version',
    'go version',
  ]) assert.equal(isSafeAutoBashCommand(command), true, command);

  for (const command of [
    'ls src',
    'cat .env',
    'git diff',
    'git status && rm -rf .',
    'git log -1',
    'npm test',
    'pwd > /tmp/out',
    'echo $HOME',
  ]) assert.equal(isSafeAutoBashCommand(command), false, command);
});

test('ordinary reads remain automatic while sensitive reads prompt and protected files deny', async () => {
  const { dir, root } = await fixture();
  const events = [];
  const broker = new PermissionBroker({ emit: (event) => events.push(event) });
  try {
    assert.deepEqual(
      await broker.authorize({ sessionId: 's1', action: 'read', resources: ['src/app.js'], projectRoot: root }),
      { allowed: true, source: 'workspace-read' },
    );
    assert.deepEqual(
      await broker.authorize({ sessionId: 's1', action: 'read', resources: ['.env.example'], projectRoot: root }),
      { allowed: true, source: 'workspace-read' },
    );

    const sensitive = broker.authorize({ sessionId: 's1', action: 'read', resources: ['.env'], projectRoot: root });
    await tick();
    const request = broker.list('s1')[0];
    assert.equal(request.action, 'read');
    assert.equal(request.autoEligible, false);
    broker.reply(request.id, 'reject');
    await assert.rejects(sensitive, (error) => error instanceof PermissionDeniedError && error.code === 'permission_denied');

    await assert.rejects(
      broker.authorize({ sessionId: 's1', action: 'read', resources: ['.cuppet/credentials.json'], projectRoot: root }),
      (error) => error instanceof PermissionDeniedError && error.code === 'protected_resource',
    );
    assert.equal(events.some((event) => event.type === 'permission.requested'), true);
  } finally { broker.close(); await rm(dir, { recursive: true, force: true }); }
});

test('guarded auto is session-scoped and never bypasses sensitive files or symlink escapes', async () => {
  const { dir, root } = await fixture();
  const broker = new PermissionBroker();
  try {
    broker.setAuto('s1', true);
    assert.deepEqual(
      await broker.authorize({ sessionId: 's1', action: 'write', resources: ['src/new.js'], projectRoot: root }),
      { allowed: true, source: 'session-auto' },
    );
    assert.equal(await isSafeWorkspaceResource('escape/secret.txt', root), false);

    const sensitive = broker.authorize({ sessionId: 's1', action: 'edit', resources: ['.env'], projectRoot: root });
    const escaped = broker.authorize({ sessionId: 's1', action: 'read', resources: ['escape/secret.txt'], projectRoot: root });
    await tick();
    const requests = broker.list('s1');
    assert.equal(requests.length, 2);
    assert.equal(requests.every((request) => request.autoEligible === false), true);
    for (const request of requests) broker.reply(request.id, 'reject');
    await assert.rejects(sensitive, PermissionDeniedError);
    await assert.rejects(escaped, PermissionDeniedError);
  } finally { broker.close(); await rm(dir, { recursive: true, force: true }); }
});

test('plan mode blocks mutation and noninteractive runtime fails closed on prompts', async () => {
  const { dir, root } = await fixture();
  const broker = new PermissionBroker();
  const noninteractive = new PermissionBroker({ interactive: false });
  try {
    await assert.rejects(
      broker.authorize({ sessionId: 's1', action: 'write', resources: ['src/app.js'], projectRoot: root, planMode: true }),
      (error) => error instanceof PermissionDeniedError && error.code === 'plan_mode_read_only',
    );
    await assert.rejects(
      broker.authorize({ sessionId: 's1', action: 'bash', resources: ['npm test'], projectRoot: root, planMode: true }),
      (error) => error instanceof PermissionDeniedError && error.code === 'plan_mode_read_only',
    );
    assert.deepEqual(
      await broker.authorize({ sessionId: 's1', action: 'bash', resources: ['git status --short'], projectRoot: root, planMode: true }),
      { allowed: true, source: 'safe-bash' },
    );
    await assert.rejects(
      noninteractive.authorize({ sessionId: 's2', action: 'read', resources: ['.env'], projectRoot: root }),
      (error) => error instanceof PermissionDeniedError && error.code === 'interaction_required',
    );
  } finally { broker.close(); noninteractive.close(); await rm(dir, { recursive: true, force: true }); }
});

test('always approval is exact-request only and does not create a wildcard', async () => {
  const { dir, root } = await fixture();
  const broker = new PermissionBroker();
  try {
    const first = broker.authorize({ sessionId: 's1', action: 'bash', resources: ['npm test'], projectRoot: root });
    await tick();
    const request = broker.list('s1')[0];
    broker.reply(request.id, 'always');
    assert.deepEqual(await first, { allowed: true, source: 'session-exact', requestId: request.id });
    assert.deepEqual(
      await broker.authorize({ sessionId: 's1', action: 'bash', resources: ['npm test'], projectRoot: root }),
      { allowed: true, source: 'session-exact' },
    );

    const different = broker.authorize({ sessionId: 's1', action: 'bash', resources: ['npm run lint'], projectRoot: root });
    await tick();
    assert.equal(broker.list('s1').length, 1);
    broker.reply(broker.list('s1')[0].id, 'reject');
    await assert.rejects(different, PermissionDeniedError);
  } finally { broker.close(); await rm(dir, { recursive: true, force: true }); }
});