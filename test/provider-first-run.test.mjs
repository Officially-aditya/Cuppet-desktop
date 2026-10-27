import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localProviderOperations } from '../src/runtime/providers/local-provider-operations.mjs';
import { AcpSessionRuntime } from '../src/runtime/providers/transports/acp/acp-session.mjs';
import { ProviderAuthFlow } from '../src/runtime/providers/provider-auth-flow.mjs';
import { resolveAntigravityAcpInstallation } from '../src/runtime/providers/backends/antigravity-install.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-provider-setup.mjs', import.meta.url));

async function setup(t, providerID, mode) {
  const root = await mkdtemp(join(tmpdir(), 'cuppet-first-run-'));
  const authFile = join(root, 'provider-auth');
  const events = [];
  let terminalCalls = 0;
  let runtimeStarts = 0;
  let flow;
  flow = new ProviderAuthFlow({ emit: (event) => {
    events.push(event);
    if (event.kind === 'url' && event.requestId) flow.respond(event.authId, { requestId: event.requestId, action: 'accept' });
  } });
  t.after(async () => { flow.close(); await rm(root, { recursive: true, force: true }); });
  const operations = () => localProviderOperations(providerID, {
    userData: root, signal: flow.signal(providerID),
    runImpl: async (_command, args) => {
      if (args.includes('--version') || args[0] === 'version') return { stdout: providerID === 'opencode' ? 'opencode 2.0.27' : '3.0.2' };
      if (args.includes('status') || args.includes('whoami')) {
        if (!existsSync(authFile)) throw new Error('not authenticated');
        return { stdout: '{"loggedIn":true}' };
      }
      if (args[0] === 'auth' && args[1] === 'list') return { stdout: JSON.stringify([{ connections: existsSync(authFile) ? [{ type: 'credential' }] : [] }]) };
      throw new Error(`Unexpected CLI call: ${args.join(' ')}`);
    },
    acpRuntimeFactory: ({ descriptor, configuration, ...options }) => {
      runtimeStarts += 1;
      return new AcpSessionRuntime({ ...options, descriptor: { ...descriptor, sessionPersistence: false, cleanupSessions: undefined }, configuration: {
        ...configuration, cliCommand: process.execPath, cliArgs: [fixture],
        cliEnv: { TEST_SETUP_AUTH_FILE: authFile, TEST_SETUP_METHOD: mode },
      } });
    },
    onAuthenticationBrowserRequest: (request) => flow.requestBrowser(providerID, request),
    runAuthTerminal: async (command, args, { env }) => {
      terminalCalls += 1;
      assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
      if (providerID === 'opencode') assert.deepEqual(args, ['auth', 'login']);
      else if (providerID === 'mistral-vibe') assert.deepEqual(args, ['--setup']);
      else { assert.equal(command, process.execPath); assert.deepEqual(args, [fixture, '--login']); }
      await writeFile(authFile, 'authenticated');
    },
  });
  return { root, authFile, events, flow, operations, terminalCalls: () => terminalCalls, runtimeStarts: () => runtimeStarts };
}

test('Claude advertises terminal auth only with UI support, then reconnects and checks CLI auth', async (t) => {
  const h = await setup(t, 'claude-code', 'terminal');
  assert.equal((await h.operations().status()).connected, false);
  const status = await h.flow.connect('claude-code', () => h.operations().connect());
  assert.equal(status.connected, true);
  assert.equal(h.terminalCalls(), 1);
  assert.ok(h.runtimeStarts() >= 2, 'terminal login must reconnect');
  assert.equal(h.events.at(-1).kind, 'finished');
});

for (const [providerID, mode] of [['mistral-vibe', 'browser'], ['grok-build', 'grok']]) {
  test(`${providerID} authenticates its advertised browser method and verifies fresh-process readiness`, async (t) => {
    const h = await setup(t, providerID, mode);
    const before = await h.operations().status();
    assert.equal(before.connected, false);
    assert.equal(before.error, undefined, 'missing credentials are not a startup failure');
    const status = await h.flow.connect(providerID, () => h.operations().connect());
    assert.equal(status.connected, true);
    assert.equal(h.terminalCalls(), 0);
    assert.ok(h.events.some((event) => event.kind === 'url' && event.requestId));
    assert.ok(h.runtimeStarts() >= 3);
  });
}

test('OpenCode Connect runs its official login in the interactive terminal', async (t) => {
  const h = await setup(t, 'opencode', 'opencode');
  assert.equal((await h.operations().status()).connected, false);
  const status = await h.flow.connect('opencode', () => h.operations().connect());
  assert.equal(status.connected, true);
  assert.equal(h.terminalCalls(), 1);
});

test('Vibe falls back to interactive setup if browser auth acknowledges without credentials', async (t) => {
  const h = await setup(t, 'mistral-vibe', 'browser-noop');
  const status = await h.flow.connect('mistral-vibe', () => h.operations().connect());
  assert.equal(status.connected, true);
  assert.equal(h.terminalCalls(), 1);
});

test('session/new and authenticate success do not override a signed-out Claude auth check', async (t) => {
  const h = await setup(t, 'claude-code', 'unverified');
  await assert.rejects(() => h.flow.connect('claude-code', () => h.operations().connect()), /not authenticated/);
  assert.equal((await h.operations().status()).connected, false);
  assert.equal(h.events.at(-1).kind, 'failed');
});

test('a historical linked marker cannot override current authentication failure', async (t) => {
  const h = await setup(t, 'claude-code', 'terminal');
  await writeFile(join(h.root, 'cli-agent-links.json'), JSON.stringify({ 'claude-code': { linkedAt: 123 } }));
  assert.equal((await h.operations().status()).connected, false);
});

test('a real sign-in PTY accepts a code, strips the Electron flag, and exits cleanly', { skip: process.platform === 'win32', timeout: 10_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cuppet-auth-pty-'));
  const authFile = join(root, 'auth');
  let flow;
  flow = new ProviderAuthFlow({ emit: (event) => {
    if (event.kind === 'output' && event.data.includes('Paste sign-in code')) flow.respond(event.authId, { data: '123456\r' });
  } });
  t.after(async () => { flow.close(); await rm(root, { recursive: true, force: true }); });
  await flow.connect('claude-code', () => flow.runTerminal('claude-code', process.execPath, [fixture, '--login'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TEST_SETUP_AUTH_FILE: authFile }, cwd: root,
  }));
  assert.equal(existsSync(authFile), true);
});

test('cancelling a login kills its PTY and rejects later input', async () => {
  const events = [];
  const writes = [];
  let kills = 0;
  const terminal = {
    onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }),
    write: (data) => writes.push(data), resize() {}, kill: () => { kills += 1; },
  };
  const flow = new ProviderAuthFlow({ emit: (event) => events.push(event), ptyModule: { spawn: () => terminal } });
  const pending = flow.connect('claude-code', () => flow.runTerminal('claude-code', 'provider', ['login']));
  const id = events[0].authId;
  flow.respond(id, { data: 'code\r' });
  assert.deepEqual(writes, ['code\r']);
  assert.throws(() => flow.respond('another-flow', { data: 'bad' }), /no longer active/);
  flow.cancel(id);
  await assert.rejects(() => pending, /cancelled/);
  assert.equal(kills, 1);
  assert.throws(() => flow.respond(id, { data: 'late' }), /no longer active/);
  assert.equal(events.at(-1).kind, 'failed');
});

test('browser authentication requires a matching user response and cancellation releases it', async () => {
  const events = [];
  const flow = new ProviderAuthFlow({ emit: (event) => events.push(event) });
  const pending = flow.connect('mistral-vibe', async () => {
    const response = await flow.requestBrowser('mistral-vibe', { mode: 'url', url: 'https://example.com/login' });
    assert.equal(response.action, 'cancel');
  });
  const id = events[0].authId;
  assert.equal(events[1].url, 'https://example.com/login');
  assert.throws(() => flow.respond(id, { requestId: 'wrong', action: 'accept' }), /not accepting input/);
  flow.cancel(id);
  await assert.rejects(() => pending, /cancelled/);
});

test('cancelling Antigravity setup aborts its download and removes temporary files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cuppet-agy-cancel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  let reachedDownload = false;
  await assert.rejects(() => resolveAntigravityAcpInstallation({}, {
    platform: 'linux', arch: 'x64', installRoot: root, appDirectories: [], signal: controller.signal,
    fetchImpl: async (_url, { signal }) => {
      reachedDownload = true;
      assert.equal(signal, controller.signal);
      controller.abort();
      signal.throwIfAborted();
    },
  }), { name: 'AbortError' });
  assert.equal(reachedDownload, true);
  assert.equal((await readdir(root)).some((name) => name.startsWith('.install-')), false);
});
