import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OperationBroker, validRemoteUrl, validateStagedLinks } from '../src/runtime/sandbox/operation-broker.mjs';
import { PermissionBroker } from '../src/runtime/permissions.mjs';

const SHA = 'a'.repeat(40);
const URL = 'https://github.com/example/project.git';
async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'cuppet-broker-')));
  let root = join(dir, 'project');
  await mkdir(root);
  root = await realpath(root);
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return { dir, root };
}

test('push resolves a nested repository root, binds approval and isolates authenticated Git from source config/hooks', async (t) => {
  const { dir, root } = await fixture(t);
  const repositoryRoot = join(root, 'repo');
  const directory = join(repositoryRoot, 'src');
  await mkdir(directory, { recursive: true });
  const calls = [];
  const trusted = join(dir, 'trusted-bin');
  await mkdir(trusted);
  await writeFile(join(trusted, 'git-credential-osxkeychain'), 'test fixture');
  let approved = false;
  let verified = false;
  let request;
  const sandbox = { async execute(command, cwd, policy) {
    calls.push({ command, cwd, policy });
    if (command.includes("'--show-toplevel'")) {
      assert.equal(cwd, root);
      assert.equal(policy.projectRoot, root);
      assert.ok(command.includes(`'-C' '${directory}'`));
      return { code: 0, stdout: repositoryRoot, stderr: '' };
    }
    assert.equal(cwd, repositoryRoot);
    if (command.includes("'rev-parse'")) return { code: 0, stdout: SHA, stderr: '' };
    if (command.includes("'get-url'")) return { code: 0, stdout: URL, stderr: '' };
    assert.equal(approved, true);
    if (command.includes("'update-ref'")) {
      assert.equal(verified, true, 'Tracking refs must only update after remote verification');
      return { code: 0, stdout: '', stderr: '' };
    }
    assert.match(command, /'bundle' 'create'/);
    assert.equal(policy.scratchDirs.length, 1);
    assert.ok(/[/\\]export$/.test(policy.scratchDirs[0]));
    await writeFile(join(policy.scratchDirs[0], 'commit.bundle'), 'test bundle');
    return { code: 0, stdout: '', stderr: '' };
  } };
  const host = [];
  const broker = new OperationBroker({ sandbox, dataDir: dir, platform: 'darwin', hostRunner: async (command, args, cwd, env) => {
    assert.equal(approved, true);
    host.push({ command, args, cwd, env });
    if (args.includes('list-heads')) return { stdout: `${SHA} HEAD\n` };
    if (args.includes('config')) return { stdout: 'osxkeychain\n' };
    if (args.includes('--exec-path')) return { stdout: `${trusted}\n` };
    if (args.includes('ls-remote')) {
      assert.ok(host.some((call) => call.args.includes('push')), 'Verification must follow push');
      verified = true;
      return { stdout: `${SHA}\trefs/heads/main\n` };
    }
    return { stdout: 'ok\n' };
  } });
  const result = await broker.gitPush({ projectRoot: root, repositoryPath: 'repo/src', remote: 'origin', branch: 'main', commit: SHA, authorize: async (value) => { request = value; approved = true; } });
  assert.deepEqual(request.resources, [repositoryRoot, 'origin', URL, 'main', SHA]);
  assert.match(result.output, /verified the remote commit/);
  assert.match(request.fingerprintKey, /^[a-f0-9]{64}$/);
  const push = host.find((call) => call.args.includes('push'));
  assert.notEqual(push.cwd, root);
  assert.equal(push.env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(push.env.GIT_CONFIG_NOSYSTEM, '1');
  assert.ok(push.args.includes('core.hooksPath=/dev/null'));
  assert.ok(push.args.includes('--no-verify'));
  assert.ok(push.args.includes('--recurse-submodules=no'));
  const expectedHelper = join(trusted, 'git-credential-osxkeychain').replace(/[^A-Za-z0-9/_.,:+-]/g, (character) => `\\${character}`);
  assert.ok(push.args.some((arg) => arg === `credential.helper=${expectedHelper}` || arg === `credential.helper=${trusted}/git-credential-osxkeychain`));
  assert.deepEqual(push.args.slice(-2), [URL, `${SHA}:refs/heads/main`]);
  const verification = host.find((call) => call.args.includes('ls-remote'));
  assert.deepEqual(verification.args.slice(0, -5), push.args.slice(0, -7));
  assert.deepEqual(verification.args.slice(-5), ['ls-remote', '--exit-code', '--refs', URL, 'refs/heads/main']);
  assert.equal(verification.cwd, push.cwd);
  assert.deepEqual(verification.env, push.env);
  assert.ok(calls.some((call) => call.command.includes(`'update-ref' 'refs/remotes/origin/main' '${SHA}'`)));
  assert.deepEqual(await readdir(join(dir, 'operation-broker')), []);
});

test('push stops before authentication if HEAD changed after approval', async (t) => {
  const { dir, root } = await fixture(t);
  const broker = new OperationBroker({ dataDir: dir, platform: 'linux',
    sandbox: exportSandbox(),
    hostRunner: async (_command, args) => {
      assert.ok(args.includes('list-heads'), 'Authentication must not start');
      return { stdout: `${'b'.repeat(40)} HEAD\n` };
    },
  });
  await assert.rejects(broker.gitPush({ projectRoot: root, remote: 'origin', branch: 'main', commit: SHA, authorize: async () => {} }), /HEAD changed/);
  assert.deepEqual(await readdir(join(dir, 'operation-broker')), []);
});

test('tracking-ref failure preserves the successful remote push result', async (t) => {
  const { dir, root } = await fixture(t);
  const sandbox = exportSandbox();
  const execute = sandbox.execute;
  sandbox.execute = async (command, ...args) => command.includes("'update-ref'")
    ? { code: 1, stdout: '', stderr: 'locked ref' } : execute(command, ...args);
  const broker = new OperationBroker({ dataDir: dir, platform: 'darwin', sandbox,
    hostRunner: async (_command, args) => {
      if (args.includes('list-heads')) return { stdout: `${SHA} HEAD\n` };
      if (args.includes('config')) { const error = new Error('No helper'); error.code = 1; throw error; }
      if (args.includes('ls-remote')) return { stdout: `${SHA}\trefs/heads/main\n` };
      return { stdout: 'ok' };
    },
  });
  const result = await broker.gitPush({ projectRoot: root, branch: 'main', commit: SHA, authorize: async () => {} });
  assert.match(result.output, /Push succeeded, but the local tracking ref could not be updated/);
});

for (const [label, response] of [
  ['wrong commit', `${'b'.repeat(40)}\trefs/heads/main\n`],
  ['missing branch', ''],
  ['wrong branch', `${SHA}\trefs/heads/other\n`],
  ['unavailable remote', new Error('Remote verification unavailable')],
]) {
  test(`push fails verification for ${label} without updating the tracking ref`, async (t) => {
    const { dir, root } = await fixture(t);
    const sandbox = exportSandbox();
    const execute = sandbox.execute;
    sandbox.execute = async (command, ...args) => {
      assert.doesNotMatch(command, /'update-ref'/);
      return execute(command, ...args);
    };
    let pushed = false;
    const broker = new OperationBroker({ dataDir: dir, platform: 'linux', sandbox,
      hostRunner: async (_command, args) => {
        if (args.includes('list-heads')) return { stdout: `${SHA} HEAD\n` };
        if (args.includes('config')) { const error = new Error('No helper'); error.code = 1; throw error; }
        if (args.includes('push')) pushed = true;
        if (args.includes('ls-remote')) {
          assert.equal(pushed, true);
          if (response instanceof Error) throw response;
          return { stdout: response };
        }
        return { stdout: 'ok' };
      },
    });
    await assert.rejects(broker.gitPush({ projectRoot: root, branch: 'main', commit: SHA, authorize: async () => {} }), /verification/i);
    assert.deepEqual(await readdir(join(dir, 'operation-broker')), []);
  });
}

test('push rejection never exports a bundle or invokes host Git', async (t) => {
  const { dir, root } = await fixture(t);
  const broker = new OperationBroker({ dataDir: dir, platform: 'linux',
    sandbox: { async execute(command, cwd) { assert.doesNotMatch(command, /'bundle'/); return { code: 0, stdout: command.includes("'--show-toplevel'") ? cwd : command.includes("'rev-parse'") ? SHA : URL }; } },
    hostRunner: async () => { assert.fail('Host Git must not run'); },
  });
  await assert.rejects(broker.gitPush({ projectRoot: root, branch: 'main', commit: SHA, authorize: async () => { throw new Error('Rejected'); } }), /Rejected/);
});

test('broker rejects custom shell credential helpers before starting authenticated push', async (t) => {
  const { dir, root } = await fixture(t);
  const broker = new OperationBroker({ dataDir: dir, platform: 'darwin',
    sandbox: exportSandbox(),
    hostRunner: async (_command, args) => {
      assert.equal(args.includes('push'), false);
      if (args.includes('list-heads')) return { stdout: `${SHA} HEAD\n` };
      if (args.includes('config')) return { stdout: '!./project-auth-script\n' };
      return { stdout: '' };
    },
  });
  await assert.rejects(broker.gitPush({ projectRoot: root, branch: 'main', commit: SHA, authorize: async () => {} }), /standard Git credential helper/);
});

test('broker refuses a standard credential helper whose executable is in the editable project', async (t) => {
  const { dir, root } = await fixture(t);
  await mkdir(join(root, 'repo'));
  await writeFile(join(root, 'git-credential-store'), 'untrusted');
  const broker = new OperationBroker({ dataDir: dir, platform: 'linux',
    sandbox: exportSandbox(),
    hostRunner: async (_command, args) => {
      assert.equal(args.includes('push'), false);
      if (args.includes('list-heads')) return { stdout: `${SHA} HEAD\n` };
      if (args.includes('config')) return { stdout: 'store\n' };
      if (args.includes('--exec-path')) return { stdout: `${root}\n` };
      return { stdout: '' };
    },
  });
  await assert.rejects(broker.gitPush({ projectRoot: root, repositoryPath: 'repo', branch: 'main', commit: SHA, authorize: async () => {} }), /outside the project/);
});

test('broker rejects repository paths, symlinks and discovered roots outside the workspace before approval', async (t) => {
  const { dir, root } = await fixture(t);
  await symlink(dir, join(root, 'escape'), process.platform === 'win32' ? 'junction' : undefined);
  const broker = new OperationBroker({ dataDir: dir, platform: 'linux',
    sandbox: { async execute(command) {
      assert.match(command, /'rev-parse' '--show-toplevel'/);
      return { code: 0, stdout: dir, stderr: '' };
    } },
    hostRunner: async () => assert.fail('Host Git must not run'),
  });
  const authorize = async () => assert.fail('An escaping repository must not request approval');
  for (const repositoryPath of ['..', 'escape', '.']) {
    await assert.rejects(broker.gitPush({ projectRoot: root, repositoryPath, branch: 'main', commit: SHA, authorize }), /inside|symlink/);
  }
});

test('broker rejects ambiguous remotes, arbitrary commands and escaping packaging paths before approval', async (t) => {
  const { dir, root } = await fixture(t);
  const broker = new OperationBroker({ dataDir: dir, platform: 'darwin',
    sandbox: { async execute(command, cwd) { return { code: 0, stdout: command.includes("'--show-toplevel'") ? cwd : command.includes("'rev-parse'") ? SHA : `${URL}\n${URL}` }; } },
  });
  const authorize = () => { assert.fail('Invalid inputs must not request approval'); };
  for (const args of [{ remote: '-x' }, { branch: 'main:other' }, { commit: 'HEAD' }]) {
    await assert.rejects(broker.gitPush({ projectRoot: root, remote: 'origin', branch: 'main', commit: SHA, ...args, authorize }));
  }
  await assert.rejects(broker.gitPush({ projectRoot: root, branch: 'main', commit: SHA, authorize }), /one HTTPS or SSH remote/);
  await assert.rejects(broker.packageDmg({ projectRoot: root, source: '../Outside.app', output: 'app.dmg', authorize }), /inside/);
  await mkdir(join(root, 'Demo.app'));
  await symlink(dir, join(root, 'escape'), process.platform === 'win32' ? 'junction' : undefined);
  await assert.rejects(broker.packageDmg({ projectRoot: root, source: 'Demo.app', output: 'escape/app.dmg', authorize }), /symlink/);
});

test('remote validation excludes credential-bearing URLs and executable Git transports', () => {
  for (const value of [URL, 'git@github.com:example/project.git', 'ssh://git@github.com/example/project.git']) assert.equal(validRemoteUrl(value), true, value);
  for (const value of ['file:///tmp/repo', '/tmp/repo', 'ext::evil', 'https://token@github.com/a/b', 'https://u:p@github.com/a/b', `${URL}?token=x`, 'ssh://git:secret@github.com/a/b', '-x', `${URL}\n`]) assert.equal(validRemoteUrl(value), false, value);
});

test('DMG staging permits app framework links but rejects links outside staging', { skip: process.platform === 'win32' }, async (t) => {
  const { root } = await fixture(t);
  await mkdir(join(root, 'Versions', 'A'), { recursive: true });
  await writeFile(join(root, 'Versions', 'A', 'binary'), 'app');
  await symlink('A', join(root, 'Versions', 'Current'));
  await symlink('Versions/Current/binary', join(root, 'binary'));
  await validateStagedLinks(root);
  await symlink('../../secret', join(root, 'escape'));
  await assert.rejects(validateStagedLinks(root), /escapes/);
});

test('broker pushes need no extra prompt, packaging keeps its approval, and plan mode stays read-only', async () => {
  const broker = new PermissionBroker({ interactive: false });
  try {
    for (const mode of [false, true, 'full']) {
      broker.setAuto('s', mode);
      for (const action of ['git-push', 'package-dmg']) {
        const request = { sessionId: 's', action, projectRoot: '/project', resources: ['bound-operation'] };
        if (mode === 'full') {
          assert.deepEqual(await broker.authorize(request), { allowed: true, source: 'session-full-access' });
          assert.equal(broker.list('s').length, 0);
        } else if (action === 'git-push') {
          assert.deepEqual(await broker.authorize(request), { allowed: true, source: 'broker-git-push' });
          assert.equal(broker.list('s').length, 0);
        } else {
          await assert.rejects(broker.authorize(request), { code: 'interaction_required' });
        }
        await assert.rejects(broker.authorize({ sessionId: 's', action, projectRoot: '/project', planMode: true }), { code: 'plan_mode_read_only' });
      }
    }
  } finally { broker.close(); }
});

function exportSandbox() {
  return { async execute(command, cwd, policy) {
    if (command.includes("'bundle'")) await writeFile(join(policy.scratchDirs[0], 'commit.bundle'), 'test bundle');
    return { code: 0, stdout: command.includes("'--show-toplevel'") ? cwd : command.includes("'rev-parse'") ? SHA : command.includes("'get-url'") ? URL : '' };
  } };
}
