import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { buildMacSeatbeltProfile } from '../src/runtime/sandbox/mac-seatbelt-driver.mjs';
import { SandboxManager } from '../src/runtime/sandbox/sandbox-manager.mjs';

test('buildMacSeatbeltProfile generates valid profile with path and credential rules', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-sandbox-test-'));
  const realDir = await import('node:fs/promises').then(fs => fs.realpath(dir));
  const profile = await buildMacSeatbeltProfile({
    projectRoot: dir,
    protectSensitiveCredentials: true,
    offline: false,
  });

  assert.match(profile, /\(version 1\)/);
  assert.match(profile, /\(deny file-write\*\)/);
  assert.match(profile, new RegExp(`\\(allow file-write\\* \\(subpath "${realDir}"\\)\\)`));
  assert.match(profile, /\(deny file-read\* \(subpath ".*\.ssh"\)\)/);
  assert.match(profile, /\(deny file-read\* \(subpath ".*\.aws"\)\)/);
  assert.doesNotMatch(profile, /\(deny network\*\)/);

  await rm(dir, { recursive: true, force: true });
});

test('buildMacSeatbeltProfile includes network denial when offline is true', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-sandbox-test-'));
  const profile = await buildMacSeatbeltProfile({
    projectRoot: dir,
    protectSensitiveCredentials: true,
    offline: true,
  });

  assert.match(profile, /\(deny network\*\)/);
  assert.match(profile, /\(deny network-outbound\)/);

  await rm(dir, { recursive: true, force: true });
});

test('SandboxManager executes basic command inside sandbox on macOS', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('macOS Seatbelt only runs on darwin');
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'cuppet-sandbox-exec-'));
  const manager = new SandboxManager();

  const result = await manager.execute('echo "sandboxed-ok"', dir, {
    projectRoot: dir,
    protectSensitiveCredentials: true,
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /sandboxed-ok/);
  assert.equal(result.driverName, 'mac-seatbelt');

  await rm(dir, { recursive: true, force: true });
});

test('SandboxManager permits writes inside projectRoot and denies writes outside', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('macOS Seatbelt only runs on darwin');
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'cuppet-sandbox-writes-'));
  const manager = new SandboxManager();

  // 1. Write inside projectRoot should succeed
  const writeInside = await manager.execute('echo "inside" > test.txt && cat test.txt', dir, {
    projectRoot: dir,
    protectSensitiveCredentials: true,
  });

  assert.equal(writeInside.code, 0, `writeInside failed with stderr: ${writeInside.stderr}`);
  assert.match(writeInside.stdout, /inside/);

  // 2. Write outside projectRoot (e.g. to user home) should fail / be denied
  const outsidePath = join(homedir(), `cuppet-sandbox-illegal-${Date.now()}.txt`);
  const writeOutside = await manager.execute(`touch "${outsidePath}"`, dir, {
    projectRoot: dir,
    protectSensitiveCredentials: true,
  });

  assert.notEqual(writeOutside.code, 0);
  assert.match(writeOutside.stderr, /(?:Operation not permitted|Permission denied)/i);

  await rm(dir, { recursive: true, force: true });
});

test('SandboxManager blocks reading sensitive host credentials (~/.ssh)', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('macOS Seatbelt only runs on darwin');
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'cuppet-sandbox-creds-'));
  const manager = new SandboxManager();

  // Attempting to list or read ~/.ssh should be denied by sandbox
  const readSsh = await manager.execute('ls -la ~/.ssh', dir, {
    projectRoot: dir,
    protectSensitiveCredentials: true,
  });

  // Either exit code != 0 or Permission denied
  const blocked = readSsh.code !== 0 || /Permission denied/i.test(readSsh.stderr);
  assert.equal(blocked, true, 'Reading ~/.ssh must be blocked by the sandbox');

  await rm(dir, { recursive: true, force: true });
});

test('SandboxManager blocks network connections when offline is true', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('macOS Seatbelt only runs on darwin');
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'cuppet-sandbox-net-'));
  const manager = new SandboxManager();

  // Attempt to reach google.com with 2s timeout in offline mode
  const curlOffline = await manager.execute('curl -m 2 https://google.com', dir, {
    projectRoot: dir,
    offline: true,
  });

  assert.notEqual(curlOffline.code, 0);
  assert.match(curlOffline.stderr, /(?:Operation not permitted|Could not resolve|Failed to connect|Permission denied)/i);

  await rm(dir, { recursive: true, force: true });
});

test('buildMacSeatbeltProfile with fullAccess: true does not deny credential paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-sandbox-full-'));
  const profile = await buildMacSeatbeltProfile({
    projectRoot: dir,
    fullAccess: true,
  });

  assert.match(profile, /\(allow default\)/);
  assert.match(profile, /\(deny file-write-unlink\)/);
  assert.doesNotMatch(profile, /\(deny file-read\* \(subpath ".*\.ssh"\)\)/);
  assert.doesNotMatch(profile, /\(deny file-read\* \(subpath ".*Keychains"\)\)/);

  await rm(dir, { recursive: true, force: true });
});

test('SandboxManager in full access mode allows credential environment and git tools', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('macOS Seatbelt only runs on darwin');
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'cuppet-sandbox-full-exec-'));
  const manager = new SandboxManager();

  const spec = await manager.getSpawnSpec('git status', {
    projectRoot: dir,
    fullAccess: true,
  });

  assert.equal(spec.env.GIT_TERMINAL_PROMPT, '0');

  const result = await manager.execute('echo $GIT_TERMINAL_PROMPT', dir, {
    projectRoot: dir,
    fullAccess: true,
  });

  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), '0');

  await rm(dir, { recursive: true, force: true });
});

