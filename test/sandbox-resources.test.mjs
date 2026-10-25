import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { SandboxManager } from '../src/runtime/sandbox/sandbox-manager.mjs';
import { getLinuxBwrapSpawnSpec } from '../src/runtime/sandbox/linux-bwrap-driver.mjs';
import { buildMacSeatbeltProfile } from '../src/runtime/sandbox/mac-seatbelt-driver.mjs';
import { PROVIDER_CREDENTIAL_PATHS, providerCredentialPaths } from '../src/runtime/sandbox/types.mjs';

async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'cuppet-resources-')));
  const root = join(dir, 'project');
  await mkdir(root);
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return { dir, root, cacheRoot: join(dir, 'caches') };
}
const mac = { skip: process.platform !== 'darwin' };

test('Windows keeps unrestricted spawn and Full Access environment without creating sandbox resources', async () => {
  const sandbox = new SandboxManager({ platform: 'win32', cacheRoot: '/must-not-create' });
  const spec = await sandbox.getSpawnSpec('npm test', { projectRoot: 'C:\\Project', fullAccess: true });
  assert.equal(spec.command, 'npm test');
  assert.equal(spec.shell, true);
  assert.equal(spec.driverName, 'host-fallback');
  assert.equal(spec.env.SSH_AUTH_SOCK, process.env.SSH_AUTH_SOCK);
  assert.equal(spec.env.GH_TOKEN, process.env.GH_TOKEN);
  assert.equal(spec.env.npm_config_cache, undefined);
});

test('Unix Full Access uses host execution and Git/SSH configuration without requiring sandbox resources', async (t) => {
  const { dir, root } = await fixture(t);
  const savedSocket = process.env.SSH_AUTH_SOCK;
  process.env.SSH_AUTH_SOCK = join(dir, 'test-agent.sock');
  t.after(() => { if (savedSocket === undefined) delete process.env.SSH_AUTH_SOCK; else process.env.SSH_AUTH_SOCK = savedSocket; });
  for (const platform of ['darwin', 'linux']) {
    const manager = new SandboxManager({ platform, cacheRoot: join(dir, 'unused-cache') });
    manager.isAvailable = async () => { throw new Error('Full Access must not require a sandbox driver'); };
    const command = 'git status';
    const spec = await manager.getSpawnSpec(command, { projectRoot: root, fullAccess: true });
    assert.equal(spec.command, command);
    assert.deepEqual(spec.args, []);
    assert.equal(spec.shell, true);
    assert.equal(spec.driverName, 'host-fallback');
    assert.equal(spec.env.SSH_AUTH_SOCK, process.env.SSH_AUTH_SOCK);
    assert.equal(spec.env.GIT_CONFIG_GLOBAL, undefined);
    assert.equal(spec.env.GIT_CONFIG_COUNT, undefined);
    assert.equal(spec.env.GIT_ASKPASS, undefined);
    assert.equal(spec.env.npm_config_userconfig, undefined);
    await assert.rejects(readFile(join(dir, 'unused-cache')));
  }
});

test('Full Access can write outside the project and use an existing Git credential helper', async (t) => {
  const { dir, root } = await fixture(t);
  const globalConfig = join(dir, 'gitconfig');
  await writeFile(globalConfig, '[credential]\n\thelper = full-access-test\n');
  const outside = join(dir, 'outside.txt');
  const manager = new SandboxManager({ protectedPaths: [dir] });
  const policy = { projectRoot: root, fullAccess: true, envOverrides: { GIT_CONFIG_GLOBAL: globalConfig } };
  const writeCommand = process.platform === 'win32'
    ? `node -e "require('node:fs').writeFileSync(process.argv[1], 'allowed')" "${outside}"`
    : `printf allowed > '${outside}'`;
  const written = await manager.execute(writeCommand, root, policy);
  assert.equal(written.code, 0, written.stderr);
  assert.equal(await readFile(outside, 'utf8'), 'allowed');
  const configured = await manager.execute('git config --global --get credential.helper', root, policy);
  assert.equal(configured.code, 0, configured.stderr);
  assert.equal(configured.stdout.trim(), 'full-access-test');
  assert.equal(configured.driverName, 'host-fallback');
});

test('Unix Default and Auto refuse an explicit sandbox bypass instead of falling back to host execution', async () => {
  for (const platform of ['darwin', 'linux']) {
    await assert.rejects(new SandboxManager({ platform }).getSpawnSpec('echo unsafe', { projectRoot: '/tmp' }, { enabled: false }), /No command was run/);
  }
});

test('Linux exposes selected toolchains instead of all home credentials, grants workspace/cache writes, and isolates tmp', async (t) => {
  const { dir, root } = await fixture(t);
  const cache = join(dir, 'cache');
  await mkdir(cache);
  const { args } = await getLinuxBwrapSpawnSpec('npm test', { projectRoot: root, scratchDirs: [cache] });
  const homeIndex = args.findIndex((value, i) => value === '--ro-bind' && args[i + 1] === homedir());
  const rootIndex = args.findIndex((value, i) => value === '--bind' && args[i + 1] === root);
  assert.equal(homeIndex, -1);
  assert.ok(rootIndex >= 0);
  assert.ok(args.includes('--unshare-user'));
  assert.ok(args.some((value, i) => value === '--tmpfs' && args[i + 1] === '/tmp'));
  assert.equal(args.some((value, i) => value === '--bind' && args[i + 1] === '/tmp'), false);
  assert.ok(args.some((value, i) => value === '--bind' && args[i + 1] === cache));
});

test('Mac sandbox caches/temp are writable, reused only by this project, and sibling temporary folders remain protected', mac, async (t) => {
  const { dir, root, cacheRoot } = await fixture(t);
  const manager = new SandboxManager({ cacheRoot });
  const policy = { projectRoot: root };
  const spec = await manager.getSpawnSpec('npm test', policy);
  assert.equal(spec.env.SSH_AUTH_SOCK, undefined);
  assert.equal(spec.env.GH_TOKEN, undefined);
  for (const variable of ['TMPDIR', 'npm_config_cache', 'ELECTRON_CACHE', 'ELECTRON_BUILDER_CACHE', 'PIP_CACHE_DIR', 'CARGO_HOME', 'GOCACHE']) {
    const result = await manager.execute(`printf ok > "$${variable}/probe"`, root, policy);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readFile(join(spec.env[variable], 'probe'), 'utf8'), 'ok');
  }
  const outside = join(dir, 'sibling');
  const blocked = await manager.execute(`printf escaped > '${outside}'`, root, policy);
  assert.notEqual(blocked.code, 0);
  const same = await manager.getSpawnSpec('npm test', policy);
  assert.equal(same.env.TMPDIR, spec.env.TMPDIR);
  const other = join(dir, 'other');
  await mkdir(other);
  assert.notEqual((await manager.getSpawnSpec('npm test', { projectRoot: other })).env.TMPDIR, spec.env.TMPDIR);
  await rm(spec.env.npm_config_cache, { recursive: true });
  await symlink(dir, spec.env.npm_config_cache);
  await assert.rejects(manager.getSpawnSpec('npm test', policy), /must not be symlinks/);
});

test('Mac protects broker storage from agent commands while a fixed broker export can use its own job', mac, async (t) => {
  const { dir, root, cacheRoot } = await fixture(t);
  const dataDir = join(dir, 'private-runtime');
  const job = join(dataDir, 'operation-broker', 'job-test');
  await mkdir(job, { recursive: true });
  await writeFile(join(job, 'private'), 'protected');
  const manager = new SandboxManager({ cacheRoot, protectedPaths: [dataDir] });
  const blocked = await manager.execute(`cat '${job}/private'`, root, { projectRoot: root });
  assert.notEqual(blocked.code, 0);
  const exportResult = await manager.execute(`printf export > '${job}/export'`, root, { projectRoot: root, scratchDirs: [job], brokerJobDirs: [job] });
  assert.equal(exportResult.code, 0, exportResult.stderr);
  assert.equal(await readFile(join(job, 'export'), 'utf8'), 'export');
  const readAgain = await manager.execute(`cat '${job}/export'`, root, { projectRoot: root });
  assert.notEqual(readAgain.code, 0);
});

test('provider credential locations are protected without blocking provider installations or project files', async (t) => {
  const { root } = await fixture(t);
  const profile = await buildMacSeatbeltProfile({ projectRoot: root });
  for (const name of PROVIDER_CREDENTIAL_PATHS) assert.ok(profile.includes(JSON.stringify(join(homedir(), name))), name);
  assert.ok(!PROVIDER_CREDENTIAL_PATHS.includes('.codex'), 'the CLI installation/cache directory stays available');
  const custom = join(root, 'custom-profile');
  assert.ok(providerCredentialPaths({ CODEX_HOME: custom }).includes(join(custom, 'auth.json')));
  assert.ok(providerCredentialPaths({ CODEX_HOME: 'local-profile' }, homedir(), root).includes(join(root, 'local-profile', 'auth.json')));
  assert.ok(providerCredentialPaths({ XDG_DATA_HOME: custom }).includes(join(custom, 'opencode', 'auth.json')));
});

test('Mac denies credential-file reads from commands while provider-owned host reads and normal commands work', mac, async (t) => {
  const { dir, root, cacheRoot } = await fixture(t);
  const records = [];
  for (const [variable, filename] of [['CODEX_HOME', 'auth.json'], ['CLAUDE_CONFIG_DIR', '.credentials.json'], ['GROK_HOME', 'auth.json'], ['VIBE_HOME', '.env'], ['XDG_DATA_HOME', 'opencode/auth.json']]) {
    const directory = join(dir, variable);
    const path = join(directory, filename);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, 'provider-credential-canary');
    const previous = process.env[variable];
    process.env[variable] = directory;
    t.after(() => { if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous; });
    records.push(path);
  }
  const manager = new SandboxManager({ cacheRoot });
  for (const path of records) {
    const result = await manager.execute(`cat '${path}'`, root, { projectRoot: root });
    assert.notEqual(result.code, 0, 'protected commands read a provider credential');
    assert.ok(!result.stdout.includes('provider-credential-canary'));
    assert.equal(await readFile(path, 'utf8'), 'provider-credential-canary', 'provider authentication still has host access');
  }
  const ordinary = await manager.execute('printf project-command-ok', root, { projectRoot: root });
  assert.equal(ordinary.code, 0, ordinary.stderr);
  assert.equal(ordinary.stdout, 'project-command-ok');
});

test('Linux masks configured provider credentials when a toolchain or workspace exposes them', async (t) => {
  const { root } = await fixture(t);
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = root;
  t.after(() => { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; });
  const auth = join(root, 'auth.json');
  await writeFile(auth, 'credential-canary');
  const { args } = await getLinuxBwrapSpawnSpec('npm test', { projectRoot: root });
  assert.ok(args.some((value, index) => value === '--ro-bind' && args[index + 1] === '/dev/null' && args[index + 2] === auth));
});

test('Linux protected commands run normally with configured credentials outside the workspace', { skip: process.platform !== 'linux' }, async (t) => {
  const { dir, root, cacheRoot } = await fixture(t);
  const directory = join(dir, 'provider-profile');
  await mkdir(directory);
  const auth = join(directory, 'auth.json');
  await writeFile(auth, 'provider-credential-canary');
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = directory;
  t.after(() => { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; });
  const manager = new SandboxManager({ cacheRoot });
  if (!(await manager.isAvailable())) return t.skip('bubblewrap is not installed');
  const ordinary = await manager.execute('printf command-ok', root, { projectRoot: root });
  assert.equal(ordinary.code, 0, ordinary.stderr);
  assert.equal(ordinary.stdout, 'command-ok');
  const read = await manager.execute(`cat '${auth}'`, root, { projectRoot: root });
  assert.ok(!read.stdout.includes('provider-credential-canary'));
  assert.equal(await readFile(auth, 'utf8'), 'provider-credential-canary');
});
