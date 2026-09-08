import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
    await manager.close();
    await assert.rejects(access(join(dataDir, 'remote')), { code: 'ENOENT' });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
