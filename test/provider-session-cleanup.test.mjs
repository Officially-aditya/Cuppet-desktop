import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, mkdir, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProviderSessionStore, providerSessionScope } from '../src/runtime/providers/session-store.mjs';
import { AcpSessionRuntime } from '../src/runtime/providers/transports/acp/acp-session.mjs';
import { AcpProcess } from '../src/runtime/providers/transports/acp/acp-process.mjs';
import { discoverAcpRuntimeCatalog } from '../src/runtime/providers/transports/acp/acp-discovery.mjs';
import { cleanupOwnedProviderSessions, deleteAntigravitySessions } from '../src/runtime/providers/session-cleanup.mjs';
import { localCliDescriptor } from '../src/runtime/local-cli-descriptors.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-acp-cleanup-agent.mjs', import.meta.url));
const descriptor = { id: 'cleanup-fixture', label: 'Cleanup fixture', transport: 'acp', command: process.execPath, args: [fixture], versionArgs: [] };

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-session-cleanup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = join(dir, 'provider.json'), path = join(dir, 'owned.json'), log = join(dir, 'rpc.jsonl');
  await writeFile(db, JSON.stringify(['unrelated-user-session']));
  const configuration = { cliCommand: process.execPath, cliArgs: [fixture], cliEnv: { CLEANUP_TEST_DB: db, CLEANUP_TEST_LOG: log, XDG_DATA_HOME: dir } };
  return { dir, db, path, log, configuration };
}

test('retirement deletes only the returned owned session and preserves unrelated provider history', async t => {
  const f = await setup(t); const store = new ProviderSessionStore({ path: f.path });
  const runtime = new AcpSessionRuntime({ descriptor, configuration: f.configuration, sessionStore: store });
  try {
    await runtime.start();
    assert.equal(store.snapshot().length, 1);
    await runtime.runTurn({ messages: [{ role: 'user', content: 'Do work.' }] });
    await runtime.retireSession();
    assert.deepEqual(JSON.parse(await readFile(f.db, 'utf8')), ['unrelated-user-session']);
    assert.deepEqual(store.snapshot(), []);
    assert.equal(runtime.snapshot().state, 'ready');
    await runtime.newSession();
  } finally { await runtime.close(); }
  assert.deepEqual(JSON.parse(await readFile(f.db, 'utf8')), ['unrelated-user-session']);
});

test('failed cleanup is retained on disk and retried by a fresh runtime', async t => {
  const f = await setup(t); const firstStore = new ProviderSessionStore({ path: f.path });
  const failing = { ...f.configuration, cliEnv: { ...f.configuration.cliEnv, CLEANUP_TEST_FAIL: '1' } };
  const first = new AcpSessionRuntime({ descriptor, configuration: failing, sessionStore: firstStore });
  await first.start(); await first.close();
  assert.equal(firstStore.snapshot().length, 1);
  const secondStore = new ProviderSessionStore({ path: f.path });
  const expected = new AcpSessionRuntime({ descriptor, configuration: f.configuration, sessionStore: secondStore });
  await expected.start(); await expected.close();
  assert.deepEqual(secondStore.snapshot(), []);
  assert.deepEqual(JSON.parse(await readFile(f.db, 'utf8')), ['unrelated-user-session']);
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')).sessions, []);
});

test('startup recovery deletes abandoned sessions without authenticating or creating another session', async t => {
  const f = await setup(t); const store = new ProviderSessionStore({ path: f.path });
  const first = new AcpSessionRuntime({ descriptor, configuration: { ...f.configuration, cliEnv: { ...f.configuration.cliEnv, CLEANUP_TEST_FAIL: '1' } }, sessionStore: store });
  await first.start(); await first.close();
  const before = (await readFile(f.log, 'utf8')).trim().split('\n').length;
  const result = await cleanupOwnedProviderSessions({ ...f.configuration, providerID: descriptor.id }, {
    store,
    runtimeFactory: (configuration, sessionStore) => new AcpSessionRuntime({ descriptor, configuration, sessionStore }),
  });
  assert.equal(result.remaining, 0);
  const calls = (await readFile(f.log, 'utf8')).trim().split('\n').slice(before).map(JSON.parse);
  assert.deepEqual(calls.map(call => call.method), ['initialize', 'session/delete']);
  assert.deepEqual(JSON.parse(await readFile(f.db, 'utf8')), ['unrelated-user-session']);
});

test('recovery recognizes a crashed owner and leaves a different account scope untouched', async t => {
  const f = await setup(t); const store = new ProviderSessionStore({ path: f.path });
  const record = store.track({ providerID: 'test', scope: 'account-a', sessionId: 'crashed-id', cwd: f.dir });
  const saved = JSON.parse(await readFile(f.path, 'utf8'));
  saved.sessions[0].ownerPid = 2147483647;
  await writeFile(f.path, JSON.stringify(saved));
  const recovered = new ProviderSessionStore({ path: f.path });
  assert.equal(recovered.pending('account-a')[0].id, record.id);
  assert.deepEqual(recovered.pending('account-b'), []);
  const a = providerSessionScope('test', '/bin/agent', { HOME: f.dir, PROVIDER_API_KEY: 'account-a-secret' });
  const b = providerSessionScope('test', '/bin/agent', { HOME: f.dir, PROVIDER_API_KEY: 'account-b-secret' });
  assert.notEqual(a, b);
  assert.doesNotMatch(a, /secret|account/);
});

test('a failed ownership write still cleans the newly created provider session before any prompt', async t => {
  const f = await setup(t); const blocker = join(f.dir, 'file');
  await writeFile(blocker, 'not a directory');
  const store = new ProviderSessionStore({ path: join(blocker, 'owned.json') });
  const runtime = new AcpSessionRuntime({ descriptor, configuration: f.configuration, sessionStore: store });
  try { await assert.rejects(runtime.start()); } finally { await runtime.close(); }
  assert.deepEqual(JSON.parse(await readFile(f.db, 'utf8')), ['unrelated-user-session']);
  assert.doesNotMatch(await readFile(f.log, 'utf8'), /session\/prompt/);
});

test('failed and cancelled turns release their owned provider sessions', async t => {
  for (const mode of ['error', 'cancel']) {
    const f = await setup(t); const store = new ProviderSessionStore({ path: f.path });
    const runtime = new AcpSessionRuntime({ descriptor, configuration: { ...f.configuration, cliEnv: { ...f.configuration.cliEnv, CLEANUP_TEST_PROMPT: mode } }, sessionStore: store });
    try {
      await runtime.start();
      const controller = new AbortController();
      const turn = runtime.runTurn({ messages: [{ role: 'user', content: 'Work.' }] }, { signal: controller.signal });
      if (mode === 'cancel') setTimeout(() => controller.abort(), 30);
      await assert.rejects(turn);
      await runtime.retireSession();
    } finally { await runtime.close(); }
    assert.deepEqual(store.snapshot(), []);
    assert.deepEqual(JSON.parse(await readFile(f.db, 'utf8')), ['unrelated-user-session']);
  }
});

test('provider shutdown waits for a writer which ignores EOF and SIGTERM', { skip: process.platform === 'win32', timeout: 6000 }, async () => {
  const child = new AcpProcess({ command: process.execPath, args: ['-e', "process.on('SIGTERM',()=>{});process.stdin.resume();setInterval(()=>{},1000);console.log('ready');"] });
  try {
    await new Promise(resolve => child.onLine(resolve));
    await child.close();
    assert.equal(child.snapshot().state, 'stopped');
    assert.equal(child.snapshot().exit.signal, 'SIGKILL');
  } finally { await child.close(); }
});

test('ownership metadata contains no conversation text and excludes live leases from recovery', async t => {
  const f = await setup(t); const store = new ProviderSessionStore({ path: f.path });
  const record = store.track({ providerID: 'test', scope: 'account-a', sessionId: 'owned-id', cwd: '/workspace' });
  assert.deepEqual(store.pending('account-a'), []);
  assert.deepEqual(new ProviderSessionStore({ path: f.path }).pending('account-a'), []);
  assert.deepEqual(store.pending('account-b'), []);
  store.release(record);
  assert.equal(new ProviderSessionStore({ path: f.path }).pending('account-a')[0].sessionId, 'owned-id');
  assert.deepEqual(Object.keys(JSON.parse(await readFile(f.path, 'utf8'))).sort(), ['schemaVersion', 'sessions']);
});

test('Antigravity cleanup removes only the recorded UUID files and its generated artifacts', async t => {
  const f = await setup(t);
  const own = '00000000-0000-4000-8000-000000000001', foreign = '00000000-0000-4000-8000-000000000002';
  const root = join(f.dir, 'antigravity-acp');
  await mkdir(join(root, 'conversations'), { recursive: true });
  await mkdir(join(root, 'brain', own), { recursive: true });
  await writeFile(join(root, 'brain', own, 'plan.md'), 'generated');
  for (const id of [own, foreign]) await writeFile(join(root, 'conversations', `${id}.db`), 'session');
  await writeFile(join(root, 'settings.json'), 'settings');
  await deleteAntigravitySessions({ environment: { GEMINI_HOME: f.dir }, records: [{ sessionId: own }] });
  await assert.rejects(access(join(root, 'conversations', `${own}.db`)), { code: 'ENOENT' });
  await access(join(root, 'conversations', `${foreign}.db`));
  await access(join(root, 'settings.json'));
  await assert.rejects(deleteAntigravitySessions({ environment: { GEMINI_HOME: f.dir }, records: [{ sessionId: '../outside' }] }), /unsupported conversation ID/);
});

test('capability discovery uses one temporary session and cleans it after model selection', async t => {
  const f = await setup(t);
  const catalog = await discoverAcpRuntimeCatalog(descriptor.id, { descriptor, configuration: { ...f.configuration, primary: { modelID: 'model-b' } } });
  assert.equal(catalog.currentModel, 'model-b');
  const calls = (await readFile(f.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.filter(call => call.method === 'session/new').length, 1);
  assert.equal(calls.filter(call => call.method === 'session/delete').length, 1);
  assert.deepEqual(JSON.parse(await readFile(f.db, 'utf8')), ['unrelated-user-session']);
});

test('Claude and Vibe disable session persistence only in the managed child configuration', () => {
  assert.equal(localCliDescriptor('claude-code').sessionMeta.claudeCode.options.persistSession, false);
  const environment = { VIBE_SESSION_LOGGING__ENABLED: 'true', MISTRAL_API_KEY: 'existing-auth' };
  const result = localCliDescriptor('mistral-vibe').environment(environment);
  assert.equal(result.VIBE_SESSION_LOGGING__ENABLED, 'false');
  assert.equal(localCliDescriptor('mistral-vibe').sessionPersistence, undefined, 'retain deletion fallback for upstream logging regressions');
  assert.equal(result.MISTRAL_API_KEY, 'existing-auth');
  assert.equal(environment.VIBE_SESSION_LOGGING__ENABLED, 'true');
});
