import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { McpSettingsStore } from '../src/main/mcp-settings.mjs';
import { credentialStorageStatus } from '../src/main/credential-storage.mjs';
import { MCP_LIMITS, McpConfigError, mcpServerSlug, normalizeMcpServerInput, parseMcpServersJson } from '../src/shared/mcp-config.mjs';

// Deliberately not base64-of-plaintext, so a test can tell stored ciphertext from the secret.
const fakeSafeStorage = (state = {}) => ({
  isEncryptionAvailable: () => state.available !== false,
  getSelectedStorageBackend: () => state.backend ?? 'gnome_libsecret',
  encryptString: (value) => Buffer.from(`enc:${[...value].reverse().join('')}`),
  decryptString: (buffer) => {
    if (state.failDecrypt) throw new Error('keychain reset');
    return [...buffer.toString().slice(4)].reverse().join('');
  },
});

async function makeStore(t, state = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'cuppet-mcp-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'mcp-servers.json');
  const create = (override = state) => new McpSettingsStore(path, {
    safeStorage: fakeSafeStorage(override),
    credentialStorageStatusImpl: (safeStorage) => credentialStorageStatus(safeStorage, override.platform ?? (override.backend ? 'linux' : process.platform)),
  });
  const store = create();
  await store.load();
  return { store, path, create };
}

const fileServer = { name: 'Files', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] };

test('slugs are stable identifiers for tool names', () => {
  assert.equal(mcpServerSlug('My GitHub Server!'), 'my-github-server');
  assert.equal(mcpServerSlug('a'.repeat(60)).length, 32);
  assert.equal(mcpServerSlug('trailing-' + 'x'.repeat(30)).endsWith('-'), false);
});

test('server input is validated field by field with actionable messages', () => {
  const bad = (input, pattern, options) => assert.throws(() => normalizeMcpServerInput(input, options), (error) => error instanceof McpConfigError && pattern.test(error.message));
  bad({ command: 'x' }, /name is required/);
  bad({ name: '-nope', command: 'x' }, /Server name must be/);
  bad({ name: 'has\nnewline', command: 'x' }, /Server name must be/);
  bad({ name: 'ok' }, /Command is required/);
  bad({ name: 'ok', command: 'a\nb' }, /single line/);
  bad({ name: 'ok', command: 'x', args: 'not-a-list' }, /Arguments must be a list/);
  bad({ name: 'ok', command: 'x', args: [1] }, /Each argument/);
  bad({ name: 'ok', command: 'x', args: Array(MCP_LIMITS.args + 1).fill('a') }, /at most 64/);
  bad({ name: 'ok', command: 'x', env: { 'BAD-NAME': 'v' } }, /Invalid environment variable name/);
  bad({ name: 'ok', command: 'x', env: JSON.parse('{"__proto__": "x"}') }, /Invalid environment variable name/);
  bad({ name: 'ok', command: 'x', env: { A: 1 } }, /must be text/);
  bad({ name: 'ok', command: 'x', env: { A: null } }, /must be text/, { allowKeep: false });
  const ok = normalizeMcpServerInput({ name: ' Files ', command: ' npx ', args: ['-y'], env: { A: null, B: 'v' } }, { allowKeep: true });
  assert.equal(ok.name, 'Files');
  assert.equal(ok.command, 'npx');
  assert.equal(ok.env.A, null);
  assert.equal(ok.enabled, true);
  assert.equal(Object.getPrototypeOf(ok.env), null, 'env is a prototype-less map');
});

test('saved servers list names only; env values are encrypted on disk and never returned', async (t) => {
  const { store, path } = await makeStore(t);
  const view = await store.save({ ...fileServer, env: { GITHUB_TOKEN: 'ghp_supersecret' } });
  assert.deepEqual(view.servers.map((server) => ({ id: server.id, name: server.name, enabled: server.enabled, envKeys: server.envKeys })), [{ id: 'files', name: 'Files', enabled: true, envKeys: ['GITHUB_TOKEN'] }]);
  assert.ok(!JSON.stringify(view).includes('ghp_supersecret'), 'renderer value never carries a stored value');
  const onDisk = await readFile(path, 'utf8');
  assert.ok(!onDisk.includes('ghp_supersecret'), 'no plaintext on disk');
  assert.ok(!onDisk.includes(Buffer.from('ghp_supersecret').toString('base64')), 'not merely base64 either');
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);

  const runtime = store.runtimeValue().servers[0];
  assert.equal(runtime.env.GITHUB_TOKEN, 'ghp_supersecret', 'the runtime receives the decrypted value');
  assert.equal(runtime.blocked, undefined);
});

test('editing keeps secrets with null, replaces with text, and removes by omission', async (t) => {
  const { store } = await makeStore(t);
  await store.save({ ...fileServer, env: { KEEP: 'one', REPLACE: 'two', DROP: 'three' } });
  const view = await store.save({ id: 'files', ...fileServer, env: { KEEP: null, REPLACE: 'new', ADDED: 'four' } });
  assert.deepEqual(view.servers[0].envKeys, ['KEEP', 'REPLACE', 'ADDED']);
  assert.deepEqual({ ...store.runtimeValue().servers[0].env }, { KEEP: 'one', REPLACE: 'new', ADDED: 'four' });
  await assert.rejects(store.save({ id: 'files', ...fileServer, env: { NEVER_SAVED: null } }), /has no saved value/);
  await assert.rejects(store.save({ ...fileServer, name: 'Other', env: { X: null } }), /must be text/, 'null is only meaningful when editing an existing server');
});

test('ids are stable across renames; names must be unique ignoring case', async (t) => {
  const { store } = await makeStore(t);
  await store.save(fileServer);
  const second = await store.save({ name: 'FILES 2', command: 'node' });
  assert.deepEqual(second.servers.map((server) => server.id), ['files', 'files-2']);
  await assert.rejects(store.save({ name: 'files', command: 'node' }), /already exists/);
  const renamed = await store.save({ id: 'files', ...fileServer, name: 'Project files' });
  assert.equal(renamed.servers[0].id, 'files', 'tool names and saved approvals depend on the id staying put');
  await assert.rejects(store.save({ id: 'files', ...fileServer, name: 'files 2' }), /already exists/);
  await assert.rejects(store.save({ id: 'ghost', ...fileServer }), /Unknown MCP server/);
});

test('without OS credential encryption, env values are refused but plain servers still work', async (t) => {
  const { store, path } = await makeStore(t, { available: false });
  assert.equal(store.rendererValue().encryptionAvailable, false);
  assert.match(store.rendererValue().encryptionUnavailableReason, /unavailable/i);
  await assert.rejects(store.save({ ...fileServer, env: { TOKEN: 'secret' } }), /will not store MCP environment values in plaintext/);
  const view = await store.save(fileServer);
  assert.equal(view.servers.length, 1);
  assert.ok(!(await readFile(path, 'utf8')).includes('secret'));
});

test('the Linux basic_text backend is not real encryption and is refused like an unavailable vault', async (t) => {
  const { store } = await makeStore(t, { backend: 'basic_text' });
  const view = store.rendererValue();
  assert.equal(view.encryptionAvailable, false);
  assert.match(view.encryptionUnavailableReason, /basic_text/);
  await assert.rejects(store.save({ ...fileServer, env: { TOKEN: 'secret' } }), /will not store MCP environment values in plaintext/);
});

test('if saved secrets cannot be decrypted the runtime is told to block the server, not run it without them', async (t) => {
  const { store, create } = await makeStore(t);
  await store.save({ ...fileServer, env: { TOKEN: 'secret' } });
  const broken = create({ failDecrypt: true });
  await broken.load();
  const runtime = broken.runtimeValue().servers[0];
  assert.match(runtime.blocked, /could not be decrypted/);
  assert.deepEqual({ ...runtime.env }, {}, 'no partial environment is handed over');
  const unavailable = create({ available: false });
  await unavailable.load();
  assert.match(unavailable.runtimeValue().servers[0].blocked, /could not be decrypted/);
});

test('enable, disable and remove persist across a reload; corrupt entries are skipped', async (t) => {
  const { store, path, create } = await makeStore(t);
  await store.save(fileServer);
  await store.save({ name: 'Second', command: 'node', env: { A: 'b' } });
  await store.setEnabled('files', false);
  await store.remove('second');
  await assert.rejects(store.remove('second'), /Unknown MCP server/);
  await assert.rejects(store.setEnabled('second', true), /Unknown MCP server/);

  const reloaded = create();
  await reloaded.load();
  assert.deepEqual(reloaded.rendererValue().servers.map((server) => [server.id, server.enabled]), [['files', false]]);

  const parsed = JSON.parse(await readFile(path, 'utf8'));
  parsed.servers.push({ id: 'bad', name: '!!', command: '' }, { id: 'files', name: 'Dup id', command: 'x' }, 'nonsense');
  await writeFile(path, JSON.stringify(parsed));
  const tolerant = create();
  await tolerant.load();
  assert.deepEqual(tolerant.rendererValue().servers.map((server) => server.name), ['Files', 'Dup id']);
  assert.deepEqual(tolerant.rendererValue().servers.map((server) => server.id), ['files', 'dup-id'], 'a colliding stored id is replaced by one derived from the name');

  await writeFile(path, '{not json');
  const empty = create();
  await empty.load();
  assert.deepEqual(empty.rendererValue().servers, []);
});

test('the server count is limited', async (t) => {
  const { store } = await makeStore(t);
  for (let index = 0; index < MCP_LIMITS.servers; index += 1) await store.save({ name: `Server ${index}`, command: 'node' });
  await assert.rejects(store.save({ name: 'One too many', command: 'node' }), /At most 16/);
});

test('a failed write leaves the in-memory settings unchanged', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cuppet-mcp-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const blocker = join(directory, 'blocker');
  await writeFile(blocker, 'a file, not a directory');
  const store = new McpSettingsStore(join(blocker, 'mcp-servers.json'), { safeStorage: fakeSafeStorage() });
  await store.load();
  await assert.rejects(store.save(fileServer));
  assert.deepEqual(store.rendererValue().servers, []);
});

test('importing mcpServers JSON adds servers disabled, and reports what it skipped', async (t) => {
  const { store } = await makeStore(t);
  await store.save({ name: 'Existing', command: 'node' });
  const text = JSON.stringify({
    mcpServers: {
      github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_import' } },
      remote: { url: 'https://example.com/mcp' },
      streamy: { type: 'http', url: 'https://example.com/mcp' },
      Existing: { command: 'node' },
      broken: { command: 'x', args: 'nope' },
      nocmd: { args: [] },
    },
  });
  const result = await store.importJson(text);
  assert.deepEqual(result.imported, ['github']);
  assert.deepEqual(Object.fromEntries(result.skipped.map((item) => [item.name, item.reason.split('.')[0]])), {
    remote: 'Remote (HTTP/SSE) servers are not supported yet; only local command servers are',
    streamy: 'Remote (HTTP/SSE) servers are not supported yet; only local command servers are',
    Existing: 'A server with this name already exists',
    broken: 'Arguments must be a list of at most 64 items',
    nocmd: 'No command to run',
  });
  const github = result.settings.servers.find((server) => server.id === 'github');
  assert.equal(github.enabled, false, 'imported commands are reviewed before they run');
  assert.deepEqual(github.envKeys, ['GITHUB_PERSONAL_ACCESS_TOKEN']);
  assert.equal(store.runtimeValue().servers.find((server) => server.id === 'github').env.GITHUB_PERSONAL_ACCESS_TOKEN, 'ghp_import');
});

test('import accepts a bare map and rejects junk', async (t) => {
  const { store } = await makeStore(t);
  assert.deepEqual((await store.importJson('{"a": {"command": "node"}}')).imported, ['a']);
  await assert.rejects(store.importJson(''), /Paste the MCP server JSON/);
  await assert.rejects(store.importJson('not json'), /not valid JSON/);
  await assert.rejects(store.importJson('{}'), /No MCP servers were found/);
  await assert.rejects(store.importJson('x'.repeat(MCP_LIMITS.importChars + 1)), /too large/);
});

test('import without credential encryption skips only the servers that need it', async (t) => {
  const { store } = await makeStore(t, { available: false });
  const result = await store.importJson(JSON.stringify({ mcpServers: { plain: { command: 'node' }, secret: { command: 'node', env: { TOKEN: 'x' } } } }));
  assert.deepEqual(result.imported, ['plain']);
  assert.match(result.skipped[0].reason, /will not store MCP environment values in plaintext/);
});

test('parseMcpServersJson normalises through the same rules as the form', () => {
  const { servers } = parseMcpServersJson('{"mcpServers":{"ok":{"command":" node ","args":["a"]}}}');
  assert.deepEqual({ ...servers[0], env: { ...servers[0].env } }, { name: 'ok', command: 'node', args: ['a'], env: {}, enabled: false });
});
