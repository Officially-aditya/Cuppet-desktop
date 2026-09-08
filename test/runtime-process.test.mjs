import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

test('runtime is independently executable without Electron or OpenCode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-process-'));
  const child = spawn(process.execPath, [join(here, '..', 'src', 'runtime', 'main.mjs')], {
    env: { ...process.env, CUPPET_DATA_DIR: dir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const messages = [];
  lines.on('line', (line) => messages.push(JSON.parse(line)));
  try {
    await waitUntil(() => messages.some((message) => message.kind === 'event' && message.event?.type === 'runtime.ready'));
    child.stdin.write(`${JSON.stringify({ id: 'health-1', method: 'health', params: {} })}\n`);
    await waitUntil(() => messages.some((message) => message.id === 'health-1'));
    const response = messages.find((message) => message.id === 'health-1');
    assert.equal(response.ok, true);
    assert.equal(response.result.runtime, 'independent');
  } finally {
    child.stdin.end();
    child.kill('SIGTERM');
    await rm(dir, { recursive: true, force: true });
  }
});

async function waitUntil(predicate, timeout = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
