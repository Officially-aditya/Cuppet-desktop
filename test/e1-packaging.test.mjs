import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { credentialStorageStatus } from '../src/main/credential-storage.mjs';
import { RuntimeClient } from '../src/main/runtime-client.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

test('Linux basic_text credential backend is rejected even when Electron reports encryption available', () => {
  const unsafe = credentialStorageStatus({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' }, 'linux');
  assert.equal(unsafe.available, false);
  assert.equal(unsafe.backend, 'basic_text');
  assert.match(unsafe.reason, /unprotected basic_text/);

  const secure = credentialStorageStatus({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret' }, 'linux');
  assert.equal(secure.available, true);
  assert.equal(secure.backend, 'gnome_libsecret');

  assert.equal(credentialStorageStatus({ isEncryptionAvailable: () => true }, 'darwin').available, true);
  assert.equal(credentialStorageStatus({ isEncryptionAvailable: () => false }, 'win32').available, false);
});

test('RuntimeClient creates its data directory, speaks stdio RPC, and shuts down gracefully', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cuppet-e1-runtime-client-'));
  await rm(dataDir, { recursive: true, force: true });
  const fixture = fileURLToPath(new URL('./fixtures/runtime-client-child.mjs', import.meta.url));
  const client = new RuntimeClient({ entry: fixture, dataDir, execPath: process.execPath, startupTimeoutMs: 3_000 });
  try {
    const ready = await client.start().then(() => client.waitForReady());
    assert.equal(ready.type, 'runtime.ready');
    const health = await client.request('health');
    assert.deepEqual(health, { ok: true, runtime: 'fixture' });
  } finally {
    await client.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('package metadata makes bootstrap security, audit, and ASAR packaging authoritative', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.main, 'src/main/bootstrap.mjs');
  assert.equal(pkg.build.appId, 'com.cuppet.desktop');
  assert.equal(pkg.build.productName, 'Cuppet');
  assert.equal(pkg.build.asar, true);
  assert.equal(pkg.build.allowMissingDependencies, false);
  assert.ok(pkg.build.files.includes('src/**/*'));
  assert.deepEqual(pkg.dependencies, {});
  assert.equal(pkg.build.asarUnpack, undefined);
  assert.equal(pkg.devDependencies.electron, '44.3.0');
  assert.equal(pkg.devDependencies['electron-builder'], '26.15.3');
  assert.equal(pkg.scripts['pack:dir'], 'electron-builder --dir');
  assert.equal(pkg.scripts['e1:audit-runtime'], 'npm audit --omit=dev --audit-level=high');
  assert.equal(pkg.scripts['e1:package-smoke'], 'node scripts/smoke-packaged-runtime.mjs');

  const bootstrap = await readFile(join(root, 'src/main/bootstrap.mjs'), 'utf8');
  assert.match(bootstrap, /requestSingleInstanceLock/);
  assert.match(bootstrap, /setWindowOpenHandler/);
  assert.match(bootstrap, /setPermissionRequestHandler/);
  assert.match(bootstrap, /setPermissionCheckHandler/);
  assert.match(bootstrap, /will-navigate/);
});
