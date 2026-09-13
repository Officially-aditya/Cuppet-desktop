import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeClient } from '../src/main/runtime-client.mjs';

test('RuntimeClient retries interrupted durable session.send with the same command id only', async () => {
  const fixture = await createCrashFixture('session.send');
  const client = new RuntimeClient({
    entry: fixture.entry,
    dataDir: fixture.dataDir,
    environment: { CUPPET_TEST_STATE: fixture.statePath, CUPPET_TEST_LOG: fixture.logPath },
    startupTimeoutMs: 2_000,
    restartDelaysMs: [0],
  });
  try {
    await client.start();
    const result = await client.request('session.send', { sessionId: 's1', text: 'do not duplicate' }, 2_000);
    assert.equal(result.ok, true);
    assert.equal(result.generation, 2);
    const calls = (await fixture.calls()).filter((item) => item.method === 'session.send');
    assert.deepEqual(calls.map((item) => item.generation), [1, 2]);
    assert.equal(calls[0].id, calls[1].id, 'durable retry must reuse one command id so the runtime receipt layer decides replay/unknown');
  } finally {
    await client.stop().catch(() => undefined);
    await fixture.cleanup();
  }
});

test('RuntimeClient retries a read-only request after runtime recovery', async () => {
  const fixture = await createCrashFixture('session.get');
  const client = new RuntimeClient({
    entry: fixture.entry,
    dataDir: fixture.dataDir,
    environment: { CUPPET_TEST_STATE: fixture.statePath, CUPPET_TEST_LOG: fixture.logPath },
    startupTimeoutMs: 2_000,
    restartDelaysMs: [0],
  });
  try {
    await client.start();
    const result = await client.request('session.get', { sessionId: 's1' }, 2_000);
    assert.equal(result.ok, true);
    assert.equal(result.generation, 2);
    const calls = await fixture.calls();
    assert.deepEqual(calls.filter((item) => item.method === 'session.get').map((item) => item.generation), [1, 2]);
  } finally {
    await client.stop().catch(() => undefined);
    await fixture.cleanup();
  }
});

async function createCrashFixture(crashMethod) {
  const root = await mkdtemp(join(tmpdir(), 'cuppet-runtime-client-recovery-'));
  const entry = join(root, 'runtime-fixture.mjs');
  const statePath = join(root, 'generation.txt');
  const logPath = join(root, 'calls.ndjson');
  const dataDir = join(root, 'runtime-data');
  await writeFile(entry, `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const statePath = process.env.CUPPET_TEST_STATE;
const logPath = process.env.CUPPET_TEST_LOG;
let previous = 0;
try { previous = Number(readFileSync(statePath, 'utf8')) || 0; } catch {}
const generation = previous + 1;
writeFileSync(statePath, String(generation));
process.stdout.write(JSON.stringify({ kind: 'event', event: { type: 'runtime.ready', generation } }) + '\\n');
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  const request = JSON.parse(line);
  appendFileSync(logPath, JSON.stringify({ id: request.id, method: request.method, generation }) + '\\n');
  if (generation === 1 && request.method === ${JSON.stringify(crashMethod)}) {
    process.exit(42);
  }
  process.stdout.write(JSON.stringify({ kind: 'response', id: request.id, ok: true, result: { ok: true, generation } }) + '\\n');
});
process.stdin.on('end', () => process.exit(0));
`, { mode: 0o600 });
  return {
    entry,
    statePath,
    logPath,
    dataDir,
    async calls() {
      try {
        const text = await readFile(logPath, 'utf8');
        return text.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      } catch { return []; }
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
