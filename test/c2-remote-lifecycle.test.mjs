import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CuppetRelay } from '../src/runtime/remote/relay.mjs';
import { RemoteManager } from '../src/runtime/remote/manager.mjs';

test('configuring then closing an unused remote manager does not create host identity or remote state', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cuppet-c2-unused-remote-'));
  try {
    const manager = new RemoteManager({
      dataDir,
      call: async () => { throw new Error('runtime should not be called during unused remote shutdown'); },
    });
    assert.deepEqual(manager.setProviderConfig({
      baseUrl: 'https://api.example.test/v1',
      model: 'model-a',
      apiKey: 'local-only',
    }), { providerConfigured: true });
    assert.deepEqual(await manager.resume(), { resumed: false });
    await manager.close();
    await assert.rejects(access(join(dataDir, 'remote')), { code: 'ENOENT' });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});


test('remote resumes the saved relay and identity after restart without another pairing invite', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cuppet-c2-resume-'));
  const relay = new CuppetRelay();
  await relay.listen(0);
  const relayUrl = `http://127.0.0.1:${relay.port}`;
  const call = async (method) => {
    if (['project.list', 'session.list', 'permission.list'].includes(method)) return [];
    throw new Error(`unexpected runtime call: ${method}`);
  };
  let first;
  let second;
  let third;
  try {
    first = new RemoteManager({ dataDir, call });
    const started = await first.start({ relayUrl });
    const hostId = started.status.hostId;
    const invites = await readdir(join(dataDir, 'remote', 'pending'));
    await first.close();
    second = new RemoteManager({ dataDir, call });
    assert.deepEqual(await second.resume(), { resumed: true });
    const status = await second.status();
    assert.equal(status.connected, true);
    assert.equal(status.hostId, hostId);
    assert.equal(status.relayUrl, relayUrl);
    assert.deepEqual(await readdir(join(dataDir, 'remote', 'pending')), invites);
    await second.stop();
    const saved = JSON.parse(await readFile(join(dataDir, 'remote', 'config.json'), 'utf8'));
    assert.equal(saved.enabled, false);
    assert.equal(saved.relayUrl, relayUrl);
    third = new RemoteManager({ dataDir, call });
    assert.deepEqual(await third.resume(), { resumed: false });
    assert.equal((await third.status()).running, false);
    // An explicit start can reuse the saved relay without another account-link QR.
    await third.start({ setup: true, createInvite: false });
    assert.equal((await third.status()).connected, true);
  } finally {
    await first?.close();
    await second?.close();
    await third?.close();
    relay.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
