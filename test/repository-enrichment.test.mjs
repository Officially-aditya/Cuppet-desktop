import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { repositoryEnrichmentSnapshot } from '../src/runtime/repository-enrichment.mjs';
import { RuntimeService } from '../src/runtime/service.mjs';

test('repository snapshots include complete small source files without following links or reading generated files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-repository-'));
  try {
    const root = join(dir, 'project');
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, '.git'));
    await mkdir(join(root, 'build'));
    await writeFile(join(root, 'src', 'engine.cc'), 'int version() { return 7; }\n');
    await writeFile(join(root, 'Makefile'), 'test:\n\techo checked\n');
    await writeFile(join(root, '.git', 'private'), 'hidden');
    await writeFile(join(root, 'build', 'generated.cc'), 'generated');
    await writeFile(join(root, 'binary'), Buffer.from([1, 0, 2]));
    await writeFile(join(dir, 'outside.txt'), 'outside');
    await symlink(join(dir, 'outside.txt'), join(root, 'linked.txt'));
    const snapshot = await repositoryEnrichmentSnapshot(root, 'original task');
    assert.deepEqual(snapshot.files.map((file) => file.path), ['Makefile', 'src/engine.cc']);
    assert.match(snapshot.signals.join('\n'), /int version\(\) \{ return 7; \}/);
    assert.doesNotMatch(snapshot.signals.join('\n'), /hidden|generated|outside/);
    assert.equal(snapshot.signals[0], 'ORIGINAL TASK REQUEST:\noriginal task');
    assert.equal(snapshot.signals.length <= 8, true);
    assert.equal(snapshot.signals.every((signal) => signal.length <= 16_000), true);
    assert.equal(await readFile(join(root, 'src', 'engine.cc'), 'utf8'), 'int version() { return 7; }\n');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('repository preparation runs once and its memories enter the first primary request', async () => {
  const env = ['CUPPET_PROVIDER_BENCHMARK', 'CUPPET_PRERUN_ENRICHMENT', 'CUPPET_DYNAMIC_ENRICHMENT', 'CUPPET_PE3'];
  const previous = Object.fromEntries(env.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { CUPPET_PROVIDER_BENCHMARK: '1', CUPPET_PRERUN_ENRICHMENT: '1', CUPPET_DYNAMIC_ENRICHMENT: '0', CUPPET_PE3: '0' });
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-preparation-'));
  const root = join(dir, 'project');
  await mkdir(root); await writeFile(join(root, 'Makefile'), 'test:\n\techo checked\n');
  let calls = 0; let primaryCalls = 0; let paused = true;
  const events = [];
  const worker = { async ready() {}, setProviderConfig() {}, pause() { paused = true; }, resume() { paused = false; }, foregroundStarted() {}, foregroundIdle() {}, async recordTurn() {}, async close() {},
    async enrichSnapshot(_id, signals, options) {
      calls++; assert.equal(paused, false); assert.equal(options.repository, true);
      assert.match(signals.join('\n'), /Makefile/);
      return { status: 'completed', candidates: 1, admittedKeys: ['validation command'], usage: { totalTokens: 10 } };
    },
  };
  const runtime = new RuntimeService({ databasePath: join(dir, 'db.sqlite3'), dataDir: dir, emit: (event) => events.push(event),
    backgroundFactory: () => worker,
    tst: { configured: true, async prepareContext() { return { stm: [{ key: 'validation command', value: 'make test' }] }; }, async turnCompleted() {}, async close() {} },
    providerFactory: () => ({ async stream(messages, { onDelta }) {
      primaryCalls++;
      assert.equal(calls, 1); assert.equal(paused, true);
      assert.match(messages.map((message) => message.content).join('\n'), /validation command: make test/);
      await onDelta('done'); return { text: 'done' };
    } }),
  });
  try {
    const project = await runtime.handle('project.add-local', { path: root, name: 'fixture' });
    const session = await runtime.handle('session.create', { projectId: project.id });
    await runtime.handle('background.pause');
    const params = { sessionId: session.id, prompt: 'original task', provider: {} };
    const result = await runtime.handle('background.prepare-repository', params);
    assert.equal(result.candidates, 1); assert.equal(primaryCalls, 0); assert.equal(paused, true);
    await assert.rejects(runtime.handle('background.prepare-repository', params), /once before/);
    await runtime.handle('session.send', { sessionId: session.id, text: 'original task', provider: {} });
    for (let i = 0; i < 100 && !events.some((event) => event.type === 'run.finished'); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(primaryCalls, 1); assert.equal(calls, 1);
    assert.equal(events.some((event) => event.type === 'background.dynamic.started'), false);
    assert.equal(events.find((event) => event.type === 'message.completed')?.message.status, 'complete');
  } finally {
    await runtime.close(); await rm(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});
