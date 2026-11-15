import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { McpServerManager } from '../src/runtime/mcp-manager.mjs';
import { McpStdioClient, mcpChildEnvironment } from '../src/runtime/mcp-client.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));
// Never spawn the developer's login shell from tests.
const environmentOptions = { loginPathProbe: () => process.env.PATH ?? '' };
const parentEnvironment = { ...process.env, OPENAI_API_KEY: 'sk-parent-secret', GITHUB_TOKEN: 'ghp_parent', CUPPET_INTERNAL: 'yes' };

function server(id, { mode = '', env = {}, enabled = true, args = [fixture], command = process.execPath } = {}) {
  return { id, name: id, command, args, enabled, env: { ...(mode ? { FAKE_MCP_MODE: mode } : {}), ...env } };
}

function setup(t, options = {}) {
  const events = [];
  const manager = new McpServerManager({ emit: (event) => events.push(event), clientOptions: { environmentOptions, inherited: parentEnvironment }, ...options });
  t.after(() => manager.close());
  return { manager, events };
}

async function until(predicate, label = 'condition') {
  for (let i = 0; i < 400; i += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
const stateOf = (manager, id) => manager.status().find((item) => item.id === id)?.state;

test('an enabled server starts in the background and its tools are namespaced per server', async (t) => {
  const { manager } = setup(t);
  const initial = manager.configure([server('files')]);
  assert.equal(initial[0].state, 'starting', 'configure returns immediately');
  await manager.ready();
  assert.equal(stateOf(manager, 'files'), 'ready');

  const names = manager.definitions().map((definition) => definition.function.name);
  assert.ok(names.includes('mcp__files__echo'));
  assert.ok(names.includes('mcp__files__write_note'), 'characters outside [A-Za-z0-9_-] are replaced');
  assert.ok(names.every((name) => /^[A-Za-z0-9_-]{1,64}$/.test(name)), 'every name satisfies provider tool-name rules');

  const echo = manager.definitions().find((definition) => definition.function.name === 'mcp__files__echo').function;
  assert.match(echo.description, /\[MCP server "files"\] Echo the text back/);
  assert.deepEqual(echo.parameters.required, ['text']);
  const bare = manager.definitions().find((definition) => definition.function.name === 'mcp__files__write_note').function;
  assert.deepEqual(bare.parameters, { type: 'object', properties: {} }, 'object schemas always carry properties');

  assert.deepEqual(manager.describe('mcp__files__echo'), { serverId: 'files', serverName: 'files', toolName: 'echo', readOnly: true });
  assert.equal(manager.describe('mcp__files__write_note').readOnly, false, 'only an explicit readOnlyHint counts as read-only');
  assert.equal(manager.has('mcp__files__echo'), true);
  assert.equal(manager.has('browser_status'), false);
  assert.equal((await manager.call('mcp__files__echo', { text: 'hi' })).output, 'echo:hi');
});

test('disabled servers are never started and report as disabled', async (t) => {
  const { manager } = setup(t);
  manager.configure([server('off', { enabled: false })]);
  await manager.ready();
  assert.equal(stateOf(manager, 'off'), 'disabled');
  assert.deepEqual(manager.definitions(), []);
  assert.equal(manager.hasServers(), false);
  await assert.rejects(manager.restart('off'), /Enable this server/);
});

test('the child gets a sanitised environment: no inherited credentials, configured values present', async (t) => {
  const { manager } = setup(t);
  manager.configure([server('env', { env: { FAKE_TOKEN: 'configured-value' } })]);
  await manager.ready();
  const report = JSON.parse((await manager.call('mcp__env__env', {})).output);
  assert.equal(report.value, 'configured-value');
  for (const leaked of ['OPENAI_API_KEY', 'GITHUB_TOKEN', 'CUPPET_INTERNAL']) assert.ok(!report.names.includes(leaked), `${leaked} must not be inherited`);
  assert.ok(report.names.includes('PATH'), 'PATH is kept so commands such as npx resolve');
  assert.equal(report.cwd, homedir(), 'servers start in the home directory, not the app bundle');
});

test('mcpChildEnvironment keeps Windows basics, drops secrets and lets configured values win', () => {
  const inherited = { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', APPDATA: 'C:\\Users\\a\\AppData', OPENAI_API_KEY: 'sk', AWS_SECRET_ACCESS_KEY: 'x' };
  const environment = mcpChildEnvironment({ PATH: 'C:\\custom' }, inherited, 'win32', { loginPathProbe: () => '' });
  assert.equal(environment.SystemRoot, 'C:\\Windows');
  assert.equal(environment.APPDATA, 'C:\\Users\\a\\AppData');
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(environment.PATH, 'C:\\custom');
});

test('connectivity settings pass through (CA bundles, proxies, npm config) while credentials still do not', () => {
  const inherited = {
    PATH: '/usr/bin', HOME: '/home/a',
    NODE_EXTRA_CA_CERTS: '/etc/corp-ca.pem', SSL_CERT_FILE: '/etc/ssl/ca.pem', HTTPS_PROXY: 'http://proxy.corp:3128', no_proxy: 'localhost',
    NPM_CONFIG_USERCONFIG: '/home/a/.npmrc', npm_config_registry: 'https://registry.corp/', XDG_CACHE_HOME: '/home/a/.cache',
    // Look-alikes that must NOT pass: tokens, including ones in npm's own variable namespace.
    NPM_CONFIG__AUTHTOKEN: 'npm_secret', 'npm_config_//registry.npmjs.org/:_authToken': 'npm_secret2', OPENAI_API_KEY: 'sk-x', GITHUB_TOKEN: 'ghp_x', AWS_SECRET_ACCESS_KEY: 'aws', SSH_AUTH_SOCK: '/tmp/agent',
  };
  const environment = mcpChildEnvironment({}, inherited, 'linux', { loginPathProbe: () => '' });
  assert.equal(environment.NODE_EXTRA_CA_CERTS, '/etc/corp-ca.pem');
  assert.equal(environment.SSL_CERT_FILE, '/etc/ssl/ca.pem');
  assert.equal(environment.HTTPS_PROXY, 'http://proxy.corp:3128');
  assert.equal(environment.no_proxy, 'localhost');
  assert.equal(environment.NPM_CONFIG_USERCONFIG, '/home/a/.npmrc');
  assert.equal(environment.npm_config_registry, 'https://registry.corp/');
  assert.equal(environment.XDG_CACHE_HOME, '/home/a/.cache');
  for (const secret of ['NPM_CONFIG__AUTHTOKEN', 'npm_config_//registry.npmjs.org/:_authToken', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'SSH_AUTH_SOCK']) {
    assert.equal(environment[secret], undefined, `${secret} must not be inherited`);
  }
  assert.equal(mcpChildEnvironment({ HTTPS_PROXY: 'http://override' }, inherited, 'linux', { loginPathProbe: () => '' }).HTTPS_PROXY, 'http://override', 'configured values still win');
});

test('long and colliding tool names stay unique, valid and stable', async (t) => {
  const { manager } = setup(t);
  manager.configure([server('long', { mode: 'long-names' })]);
  await manager.ready();
  const names = manager.definitions().map((definition) => definition.function.name);
  assert.equal(names.length, 4);
  assert.equal(new Set(names).size, 4, 'x y and x_y both sanitise to x_y but must not collide');
  assert.ok(names.every((name) => /^[A-Za-z0-9_-]{1,64}$/.test(name)));
  const first = names.slice();
  manager.configure([server('long', { mode: 'long-names' })]);
  assert.deepEqual(manager.definitions().map((definition) => definition.function.name), first, 'reconfiguring with the same servers keeps names');
});

test('a tool that reports isError rejects with the server message; images are passed through', async (t) => {
  const { manager } = setup(t);
  manager.configure([server('s')]);
  await manager.ready();
  await assert.rejects(manager.call('mcp__s__fail', {}), /it broke/);
  const result = await manager.call('mcp__s__image', {});
  assert.equal(result.contentItems[0].type, 'inputImage');
  assert.match(result.contentItems[0].imageUrl, /^data:image\/png;base64,/);
  assert.equal(result.contentItems[1].text, 'pic');
});

test('a server that exits during startup reports why, with secrets scrubbed from its output', async (t) => {
  const { manager } = setup(t);
  manager.configure([server('crash', { mode: 'crash-on-start', env: { FAKE_SECRET: 'super-secret-value' } })]);
  await manager.ready();
  const status = manager.status()[0];
  assert.equal(status.state, 'error');
  assert.match(status.message, /exited \(code 3\)/);
  assert.match(status.message, /fatal: cannot start/);
  assert.doesNotMatch(status.message, /super-secret-value/, 'configured values never reach the UI');
  assert.deepEqual(manager.definitions(), []);
});

test('a missing command gives an actionable message', async (t) => {
  const { manager } = setup(t);
  manager.configure([server('missing', { command: 'definitely-not-installed-cuppet-test', args: [] })]);
  await manager.ready();
  const status = manager.status()[0];
  assert.equal(status.state, 'error');
  assert.match(status.message, /Command not found: "definitely-not-installed-cuppet-test"/);
});

test('unsupported protocol versions are rejected clearly; older supported ones work', async (t) => {
  const { manager } = setup(t);
  manager.configure([server('bad', { mode: 'bad-protocol' }), server('old', { mode: 'old-protocol' })]);
  await manager.ready();
  assert.equal(stateOf(manager, 'bad'), 'error');
  assert.match(manager.status()[0].message, /unsupported MCP version/);
  assert.equal(stateOf(manager, 'old'), 'ready');
});

test('a server without the tools capability is ready with no tools and says so', async (t) => {
  const { manager } = setup(t);
  manager.configure([server('quiet', { mode: 'no-tools' })]);
  await manager.ready();
  const status = manager.status()[0];
  assert.equal(status.state, 'ready');
  assert.equal(status.toolCount, 0);
  assert.match(status.message, /does not provide tools/);
});

test('startup that never completes is bounded by a timeout and cleans up the process', async () => {
  const client = new McpStdioClient({ command: process.execPath, args: [fixture], env: { FAKE_MCP_MODE: 'hang-start' }, inherited: parentEnvironment, environmentOptions });
  await assert.rejects(client.start({ timeoutMs: 250 }), /did not finish starting within 250 ms/);
  assert.equal(client.running, false);
});

test('a slow start (e.g. npx still downloading) gets the startup budget, not the ordinary request timeout', async (t) => {
  const options = { command: process.execPath, args: [fixture], env: { FAKE_MCP_MODE: 'slow-start', FAKE_MCP_DELAY_MS: '600' }, inherited: parentEnvironment, environmentOptions };
  // Ordinary requests are limited to 150ms here, shorter than the 600ms the server takes to answer initialize.
  const patient = new McpStdioClient({ ...options, requestTimeoutMs: 150 });
  t.after(() => patient.close());
  await patient.start({ timeoutMs: 5000 });
  assert.equal(patient.tools.length, 6, 'initialize waited for the slow server, then tools/list ran under the ordinary timeout');

  const impatient = new McpStdioClient({ ...options, requestTimeoutMs: 150 });
  await assert.rejects(impatient.start({ timeoutMs: 300 }), /did not finish starting within 300 ms/, 'the startup budget is still a hard limit');
  assert.equal(impatient.running, false);
});

test('aborting a call rejects immediately and tells the server to cancel', async (t) => {
  const client = new McpStdioClient({ command: process.execPath, args: [fixture], inherited: parentEnvironment, environmentOptions });
  t.after(() => client.close());
  await client.start();
  const controller = new AbortController();
  const pending = client.callTool('sleep', {}, { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, (error) => error.name === 'AbortError');
  await until(() => /cancelled:\d+/.test(client.diagnostics), 'cancellation notification');
  await assert.rejects(client.callTool('echo', { text: 'x' }, { signal: AbortSignal.abort() }), (error) => error.name === 'AbortError');
});

test('shutdown reaches a server launched through a wrapper (the npx shape), even if it ignores stdin closing', { skip: process.platform === 'win32' }, async () => {
  // `sh -c 'server; true'` forks the server as a grandchild, like `npx` does. Signalling only the shell would orphan it.
  const client = new McpStdioClient({
    command: 'sh', args: ['-c', '"$0" "$1"; true', process.execPath, fixture],
    env: { FAKE_MCP_MODE: 'linger' }, inherited: parentEnvironment, environmentOptions,
  });
  await client.start();
  const [env] = await Promise.all([client.callTool('env', {})]);
  const { pid } = JSON.parse(env.output);
  assert.doesNotThrow(() => process.kill(pid, 0), 'the grandchild is alive before shutdown');
  await client.close();
  await until(() => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } }, 'grandchild to exit');
});

test('a call that exceeds its timeout rejects and cancels', async (t) => {
  const client = new McpStdioClient({ command: process.execPath, args: [fixture], inherited: parentEnvironment, environmentOptions });
  t.after(() => client.close());
  await client.start();
  await assert.rejects(client.callTool('sleep', {}, { timeoutMs: 80 }), /timed out after 80 ms: tools\/call/);
  await until(() => /cancelled:\d+/.test(client.diagnostics), 'cancellation notification');
});

test('server-initiated requests are answered so a server never blocks on Cuppet', async (t) => {
  const client = new McpStdioClient({ command: process.execPath, args: [fixture], env: { FAKE_MCP_MODE: 'probe-client' }, inherited: parentEnvironment, environmentOptions });
  t.after(() => client.close());
  await client.start();
  await until(() => /reply:s1:\{\}/.test(client.diagnostics) && /reply:s2:.*Method not supported by Cuppet: sampling\/createMessage/.test(client.diagnostics), 'replies to server requests');
});

test('tools/list_changed refreshes the tool list and announces it', async (t) => {
  const { manager, events } = setup(t);
  manager.configure([server('live')]);
  await manager.ready();
  assert.equal(manager.has('mcp__live__added_later'), false);
  await manager.call('mcp__live__write_note', {});
  await until(() => manager.has('mcp__live__added_later'), 'refreshed tool list');
  assert.ok(events.some((event) => event.type === 'integration.mcp.updated' && event.servers[0].tools.some((tool) => tool.name === 'added_later')));
});

test('tool counts are capped per server and in total, and the overflow is reported', async (t) => {
  const { manager } = setup(t);
  manager.configure([server('a', { mode: 'many-tools' }), server('b', { mode: 'many-tools' })]);
  await manager.ready();
  const [a, b] = manager.status();
  assert.equal(a.toolCount, 64, 'one server exposes at most 64 tools');
  assert.equal(a.toolCount + b.toolCount, 96, 'all servers together expose at most 96');
  assert.match(b.message, /not offered/);
  assert.equal(manager.definitions().length, 96);
});

test('reconfiguring restarts only servers whose launch settings changed', async (t) => {
  const created = [];
  const { manager } = setup(t, { clientFactory: (options) => { const client = new McpStdioClient(options); created.push(options.command + options.args.join()); return client; }, clientOptions: { environmentOptions, inherited: parentEnvironment } });
  manager.configure([server('one'), server('two')]);
  await manager.ready();
  assert.equal(created.length, 2);

  manager.configure([{ ...server('one'), name: 'Renamed' }, server('two')]);
  await manager.ready();
  assert.equal(created.length, 2, 'a rename must not restart the process');
  assert.equal(manager.status()[0].name, 'Renamed');

  manager.configure([server('one', { env: { CHANGED: '1' } }), server('two')]);
  await manager.ready();
  assert.equal(created.length, 3, 'changed environment restarts that server only');

  manager.configure([server('two')]);
  assert.deepEqual(manager.status().map((item) => item.id), ['two'], 'removed servers disappear');
  assert.equal(manager.has('mcp__one__echo'), false);
  assert.equal(manager.has('mcp__two__echo'), true);
});

test('blocked configuration is surfaced instead of launching without its secrets', async (t) => {
  const { manager } = setup(t);
  manager.configure([{ ...server('locked'), blocked: 'Saved environment values could not be decrypted.' }]);
  await manager.ready();
  assert.equal(stateOf(manager, 'locked'), 'error');
  assert.match(manager.status()[0].message, /could not be decrypted/);
  assert.equal(manager.hasServers(), false);
  assert.deepEqual(manager.definitions(), []);
});

test('a crashed server is retried at the next turn, but not more than once per cooldown', async (t) => {
  let clock = 1_000_000;
  let attempts = 0;
  const factory = (options) => {
    attempts += 1;
    return attempts === 1
      ? { running: false, providesTools: true, tools: [], diagnostics: '', start: async () => { throw new Error('first attempt fails'); }, close: async () => {} }
      : new McpStdioClient(options);
  };
  const { manager } = setup(t, { clientFactory: factory, now: () => clock, retryCooldownMs: 15_000 });
  manager.configure([server('flaky')]);
  await manager.ready();
  assert.equal(stateOf(manager, 'flaky'), 'error');
  assert.equal(attempts, 1);

  clock += 1_000;
  await manager.ready();
  assert.equal(attempts, 1, 'inside the cooldown there is no retry');

  clock += 20_000;
  await manager.ready();
  assert.equal(attempts, 2);
  assert.equal(stateOf(manager, 'flaky'), 'ready');
});

test('a running server that dies is reported, drops its tools, and calls fail with a clear error', async (t) => {
  const { manager, events } = setup(t);
  manager.configure([server('dies')]);
  await manager.ready();
  const { pid } = JSON.parse((await manager.call('mcp__dies__env', {})).output);
  process.kill(pid, 'SIGKILL');
  await until(() => stateOf(manager, 'dies') === 'error', 'crash detection');
  assert.match(manager.status()[0].message, /stopped unexpectedly/);
  assert.equal(manager.has('mcp__dies__echo'), false, 'a dead server stops advertising tools');
  assert.deepEqual(manager.definitions(), []);
  assert.ok(events.some((event) => event.type === 'integration.mcp.updated' && event.servers[0].state === 'error'));
  await assert.rejects(manager.call('mcp__dies__echo', { text: 'x' }), /unavailable/);

  await manager.restart('dies');
  assert.equal(stateOf(manager, 'dies'), 'ready', 'restart yields a fresh, ready server');
  assert.equal((await manager.call('mcp__dies__echo', { text: 'again' })).output, 'echo:again');
});

test('close stops every server and leaves nothing callable', async (t) => {
  const { manager } = setup(t);
  manager.configure([server('x')]);
  await manager.ready();
  await manager.close();
  assert.deepEqual(manager.definitions(), []);
  assert.deepEqual(manager.status(), []);
  await assert.rejects(manager.call('mcp__x__echo', {}), /unavailable/);
});
