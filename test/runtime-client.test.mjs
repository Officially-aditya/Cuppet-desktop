import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { RuntimeClient } from '../src/main/runtime-client.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('main-process runtime client observes ready and serves requests', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-runtime-client-'));
  const client = new RuntimeClient({
    entry: join(here, '..', 'src', 'runtime', 'main.mjs'),
    dataDir: dir,
  });
  try {
    await client.start();
    const health = await client.request('health');
    assert.equal(health.ok, true);
    assert.equal(health.runtime, 'independent');
  } finally {
    await client.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
