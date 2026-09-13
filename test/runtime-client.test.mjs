import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
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

test('runtime client retries interrupted session.send only under the original durable command id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-runtime-recovery-'));
  const client = recoveryClient(dir);
  try {
    await client.start();
    const recovered = once(client, 'recovered');
    const result = await client.request('session.send', { sessionId: 'session-1', text: 'do work' });
    await recovered;
    assert.deepEqual(result, { replayed: true, sameCommandId: true });

    const health = await client.request('health');
    assert.deepEqual(health, { ok: true, runtime: 'recovery-fixture' });
  } finally {
    await client.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('runtime client replaces a stale process after idle before serving navigation reads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-runtime-stale-'));
  const client = recoveryClient(dir, { idleProbeAfterMs: 1, healthProbeTimeoutMs: 50 });
  try {
    await client.start();
    await client.request('arm-hang');
    await delay(5);

    const recovered = once(client, 'recovered');
    const session = await client.request('session.get', { sessionId: 'session-2' });
    await recovered;
    assert.equal(session.id, 'session-2');
    assert.equal(session.title, 'Recovered chat');
  } finally {
    await client.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('intentional runtime stop does not trigger recovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-runtime-stop-'));
  const client = recoveryClient(dir);
  let recoveries = 0;
  client.on('recovered', () => { recoveries += 1; });
  try {
    await client.start();
    await client.stop();
    await delay(20);
    assert.equal(recoveries, 0);
    await assert.rejects(client.request('health'), /Cuppet runtime is unavailable/);
  } finally {
    await client.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

function recoveryClient(dataDir, overrides = {}) {
  return new RuntimeClient({
    entry: join(here, '..', 'test-support', 'runtime-client-recovery-child.mjs'),
    dataDir,
    restartDelaysMs: [0, 10, 25],
    ...overrides,
  });
}
