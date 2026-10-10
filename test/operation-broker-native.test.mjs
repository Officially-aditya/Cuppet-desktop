import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SandboxManager } from '../src/runtime/sandbox/sandbox-manager.mjs';
import { OperationBroker } from '../src/runtime/sandbox/operation-broker.mjs';

const exec = promisify(execFile);
const mac = { skip: process.platform !== 'darwin' };
const unix = { skip: !['darwin', 'linux'].includes(process.platform) };
async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'cuppet-broker-native-')));
  const root = join(dir, 'project');
  const dataDir = join(dir, 'runtime');
  await mkdir(root);
  await mkdir(dataDir);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sandbox = new SandboxManager({ cacheRoot: join(dir, 'cache'), protectedPaths: [dataDir] });
  return { dir, root, dataDir, sandbox };
}

test('native sandbox stages and commits with hooks confined; broker exports/imports/pushes exact commit without source hooks', unix, async (t) => {
  const { dir, root, dataDir, sandbox } = await fixture(t);
  await exec('/usr/bin/git', ['init', root]);
  await exec('/usr/bin/git', ['-C', root, 'config', 'user.name', 'Cuppet Test']);
  await exec('/usr/bin/git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  await writeFile(join(root, 'app.txt'), 'test');
  const hook = join(root, '.git', 'hooks', 'pre-commit');
  const outside = join(dir, 'outside');
  await writeFile(hook, `#!/bin/sh\nprintf escape > '${outside}'\nprintf ok > "$TMPDIR/hook-proof"\n`);
  await chmod(hook, 0o755);
  const committed = await sandbox.execute('git add app.txt && git commit -m test', root, { projectRoot: root });
  assert.equal(committed.code, 0, committed.stderr);
  await assert.rejects(readFile(outside));
  const env = (await sandbox.getSpawnSpec('git status', { projectRoot: root })).env;
  assert.equal(await readFile(join(env.TMPDIR, 'hook-proof'), 'utf8'), 'ok');
  await exec('/usr/bin/git', ['-C', root, 'remote', 'add', 'origin', 'https://github.com/example/broker-test.git']);
  const { stdout } = await exec('/usr/bin/git', ['-C', root, 'rev-parse', 'HEAD']);
  assert.equal((await exec('/usr/bin/git', ['-C', root, 'log', '-1', '--format=%an <%ae>'])).stdout.trim(), 'Cuppet Test <test@example.com>');
  const commit = stdout.trim();
  const target = join(dir, 'target.git');
  await exec('/usr/bin/git', ['init', '--bare', target]);
  await writeFile(join(root, '.git', 'hooks', 'pre-push'), `#!/bin/sh\ntouch '${outside}'\nexit 1\n`);
  await chmod(join(root, '.git', 'hooks', 'pre-push'), 0o755);
  const broker = new OperationBroker({ sandbox, dataDir, hostRunner: async (command, args, cwd, hostEnv, signal) => {
    if (args.includes('config')) { const error = new Error('No test credentials'); error.code = 1; throw error; }
    if (args.includes('push')) {
      assert.equal(args.at(-2), 'https://github.com/example/broker-test.git');
      args = [...args.slice(0, -2), target, args.at(-1)]; // Local fixture avoids any network/authentication.
    }
    return exec(command, args, { cwd, env: hostEnv, signal });
  } });
  await broker.gitPush({ projectRoot: root, remote: 'origin', branch: 'main', commit, authorize: async () => {} });
  const pushed = await exec('/usr/bin/git', ['--git-dir', target, 'rev-parse', 'refs/heads/main']);
  assert.equal(pushed.stdout.trim(), commit);
  assert.equal((await exec('/usr/bin/git', ['-C', root, 'rev-parse', 'refs/remotes/origin/main'])).stdout.trim(), commit);
  await assert.rejects(readFile(outside));
});

test('native DMG helper creates and verifies its private image, then writes it into the project', mac, async (t) => {
  const { root, dataDir, sandbox } = await fixture(t);
  await mkdir(join(root, 'Demo.app', 'Contents'), { recursive: true });
  await writeFile(join(root, 'Demo.app', 'Contents', 'Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict/></plist>');
  const broker = new OperationBroker({ sandbox, dataDir });
  const result = await broker.packageDmg({ projectRoot: root, source: 'Demo.app', output: 'Demo.dmg', authorize: async () => {} });
  assert.equal(result.mutation, true);
  assert.deepEqual(result.paths, ['Demo.dmg']);
  assert.ok((await stat(join(root, 'Demo.dmg'))).size > 0);
  await exec('/usr/bin/hdiutil', ['verify', join(root, 'Demo.dmg')]);
});
