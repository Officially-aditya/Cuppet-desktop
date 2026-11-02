import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { TstSupervisor } from '../src/runtime/tst-supervisor.mjs';

async function fixture(t, mode, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tst-recovery-'));
  const root = join(dir, 'p'); await mkdir(root); const binary = join(dir, 'daemon.mjs');
  await writeFile(join(root, 'mode'), mode);
  await writeFile(binary, [
    "#!/usr/bin/env node",
    "import { createServer } from 'node:net';",
    "import { readFileSync, appendFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "const args = process.argv.slice(2);",
    "if (args.includes('--protocol')) { console.log('cuppet.tst.v3'); process.exit(0); }",
    "const root = args[args.indexOf('--project-root') + 1], socket = args[args.indexOf('--socket') + 1];",
    "const log = join(root, 'starts'); appendFileSync(log, process.pid + '\\n');",
    "const generation = readFileSync(log, 'utf8').trim().split('\\n').length;",
    "const mode = readFileSync(join(root, 'mode'), 'utf8'); let wedged = false;",
    "const reply = (s, id, result) => { const b = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result })); const h = Buffer.alloc(4); h.writeUInt32BE(b.length); s.write(Buffer.concat([h, b])); };",
    "createServer((s) => { s.on('error', () => {}); let buf = Buffer.alloc(0); s.on('data', (chunk) => {",
    "buf = Buffer.concat([buf, chunk]); while (buf.length >= 4) {",
    "const n = buf.readUInt32BE(); if (buf.length < n + 4) return; const r = JSON.parse(buf.subarray(4, n + 4)); buf = buf.subarray(n + 4);",
    "appendFileSync(join(root, 'calls'), generation + ':' + r.method + '\\n');",
    "if (r.method === 'initialize') { reply(s, r.id, { protocol: 'cuppet.tst.v3', capabilities: ['graph.list'] }); continue; }",
    "if (r.method === 'shutdown') { reply(s, r.id, {}); setTimeout(() => process.exit(0), 5); continue; }",
    "if (wedged) continue;",
    "if (r.method !== 'status' && (mode === 'always' || (generation === 1 && mode !== 'healthy'))) { wedged = true; continue; }",
    "reply(s, r.id, { ok: true, generation });",
    "} }); }).listen(socket);",
    "process.on('SIGTERM', () => process.exit(0));",
  ].join('\n'));
  await chmod(binary, 0o755);
  const supervisor = new TstSupervisor({ binaryPath: binary, projectRoot: root, projectStore: join(dir, 'ps'), globalStore: join(dir, 'gs'), runRoot: join(dir, 'run'), idleMs: 0, healthTimeoutMs: 30, failureThreshold: 2, maxRestarts: 2, ...options });
  t.after(async () => { await supervisor.close(); await rm(dir, { recursive: true, force: true }); });
  return { root, supervisor };
}
test('supervisor probes a hung daemon, restarts once for concurrent callers, and retries safe reads', { timeout: 15000 }, async (t) => {
  const { supervisor } = await fixture(t, 'once');
  const result = await Promise.all(Array.from({ length: 4 }, () => supervisor.call('graph.list', {}, { timeoutMs: 40 })));
  assert.ok(result.every((value) => value.ok && value.generation === 2)); assert.equal(supervisor.status.starts, 2);
});
test('timed-out mutations recover the daemon but are never replayed', { timeout: 15000 }, async (t) => {
  const { root, supervisor } = await fixture(t, 'once');
  await assert.rejects(supervisor.call('memory.remember', { key: 'x' }, { timeoutMs: 40 }), /timed out/);
  assert.equal(supervisor.status.starts, 2);
  const lines = (await readFile(join(root, 'calls'), 'utf8')).split('\n');
  assert.equal(lines.filter((line) => line.endsWith(':memory.remember')).length, 1);
  assert.equal((await supervisor.call('graph.list', {}, { timeoutMs: 100 })).generation, 2);
});
test('persistent daemon hangs trip a bounded restart budget', { timeout: 15000 }, async (t) => {
  const { supervisor } = await fixture(t, 'always', { maxRestarts: 1, restartWindowMs: 60000 });
  for (let i = 0; i < 4; i++) await assert.rejects(supervisor.call('graph.list', {}, { timeoutMs: 30 }), /timed out|recovery limit/i);
  assert.equal(supervisor.status.starts, 2); assert.ok(supervisor.status.recoveryBlockedUntil > Date.now());
});
test('callers waiting on recovery cannot bypass an exhausted restart budget', { timeout: 15000 }, async (t) => {
  const { root, supervisor } = await fixture(t, 'always', { maxRestarts: 0, healthTimeoutMs: 250 });
  const failing = supervisor.call('graph.list', {}, { timeoutMs: 30 });
  const rejected = assert.rejects(failing, /timed out/);
  const deadline = Date.now() + 3000;
  for (;;) {
    const calls = await readFile(join(root, 'calls'), 'utf8').catch(() => '');
    if (calls.split('\n').filter((line) => line.endsWith(':status')).length >= 2) break;
    assert.ok(Date.now() < deadline, 'health probe was not issued');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await assert.rejects(supervisor.call('status', {}, { timeoutMs: 100 }), /recovery limit/i);
  await rejected; assert.equal(supervisor.status.starts, 1);
});
test('Stop never triggers recovery or retries a cancelled request', { timeout: 15000 }, async (t) => {
  const { supervisor } = await fixture(t, 'once'); await supervisor.call('status');
  const controller = new AbortController(); const pending = supervisor.call('graph.list', {}, { timeoutMs: 1000, signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' }); setTimeout(() => controller.abort(), 20); await rejected;
  assert.equal(supervisor.status.starts, 1);
});
