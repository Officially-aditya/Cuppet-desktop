import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { resolveCopilotAcpRuntime, verifyCopilotAcpExecutable } from '../src/runtime/copilot-acp-runtime.mjs';
import { localProviderOperations } from '../src/runtime/providers/local-provider-operations.mjs';
import { localCliDescriptor } from '../src/runtime/local-cli-descriptors.mjs';
import { AcpSessionRuntime } from '../src/runtime/providers/transports/acp/acp-session.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-acp-config-agent.mjs', import.meta.url));
const unix = { skip: process.platform === 'win32' };
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

async function executable(path, source = `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source);
  await chmod(path, 0o755);
  return path;
}
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'cuppet-copilot-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = { PATH: root, HOME: root };
  const options = {
    platform: process.platform, home: root, environment,
    appDirectories: [], extensionDirectories: [join(root, 'extensions')],
    loginPathProbe: () => '',
    // Keep host installations out of this fixture while exercising the real ACP handshake.
    verifyImpl: (command, env) => command.startsWith(root) && verifyCopilotAcpExecutable(command, env, { timeoutMs: 2_000 }),
  };
  const bundled = (version = '1.0.0', layout = 'node_modules') => join(
    root, 'extensions', `github.copilot-chat-${version}`, layout, '@github',
    `copilot-${process.platform}-${process.arch}`, 'copilot',
  );
  return { root, options, bundled };
}

test('VS Code extension runtime is reused for Install, Connect and chat without an installer', unix, async (t) => {
  const { root, options, bundled } = await setup(t);
  const command = await executable(bundled());
  const calls = [];
  const operations = localProviderOperations('github-copilot', {
    userData: join(root, 'user-data'), copilotRuntimeOptions: options,
    runImpl: async (actual, args) => {
      calls.push([actual, args]);
      if (actual === command) assert.deepEqual(args, ['--version']);
      else assert.ok(
        (actual === '/usr/bin/security' && args.includes('find-generic-password'))
        || (actual === 'gh' && args.join(' ') === 'auth token'),
      );
      return { stdout: 'Copilot 1.0.95', stderr: '' };
    },
  });
  const detected = await operations.detect();
  assert.equal(detected.installed, true);
  assert.equal(detected.installation.executable, command);
  assert.equal(detected.installation.source, 'native');
  assert.equal(detected.installation.ownedByCuppet, false);
  assert.equal((await operations.install()).installed, true);
  assert.equal((await operations.connect()).connected, true);
  await assert.rejects(() => operations.update(), /does not own this/);

  const runtime = new AcpSessionRuntime({
    descriptor: localCliDescriptor('github-copilot'),
    configuration: { primary: { modelID: 'provider/model-b' }, primaryEffort: 'max' },
    resolveCopilotRuntimeImpl: (configuration) => resolveCopilotAcpRuntime(configuration, options),
  });
  try {
    await runtime.start();
    assert.equal((await runtime.runTurn({ messages: [] })).text, 'Done.');
  } finally { await runtime.close(); }
  assert.ok(calls.filter(([, args]) => args.includes('--version')).every(([actual]) => actual === command));
});

test('a usable standalone runtime takes precedence over app copies', unix, async (t) => {
  const { root, options, bundled } = await setup(t);
  const command = await executable(join(root, 'copilot'));
  await executable(bundled());
  assert.deepEqual(await resolveCopilotAcpRuntime({}, options), { command, source: 'unknown' });
});

test('a version-only standalone command and broken newest extension do not hide a working runtime', unix, async (t) => {
  const { root, options, bundled } = await setup(t);
  const bad = '#!/bin/sh\nprintf "Copilot 1.0.95\\n"\n';
  await executable(join(root, 'copilot'), bad);
  await executable(bundled('2.0.0'), bad);
  const command = await executable(bundled('1.0.0', join('dist', 'node_modules')));
  assert.deepEqual(await resolveCopilotAcpRuntime({}, options), { command, source: 'native' });
});

test('an app-bundled platform runtime can be reused outside the user extension directory', unix, async (t) => {
  const { root, options } = await setup(t);
  const app = join(root, 'Visual Studio Code.app');
  const command = await executable(join(app, 'Contents', 'Resources', 'app', 'node_modules', '@github', 'copilot-darwin-arm64', 'copilot'));
  const runtime = await resolveCopilotAcpRuntime({}, {
    ...options, platform: 'darwin', arch: 'arm64', appDirectories: [app], extensionDirectories: [],
  });
  assert.deepEqual(runtime, { command, source: 'native' });
});

test('app and SDK presence alone do not prevent installing the missing runtime', unix, async (t) => {
  const { root, options, bundled } = await setup(t);
  await mkdir(dirname(bundled()), { recursive: true });
  await writeFile(join(dirname(bundled()), 'sdk.js'), 'export {};');
  assert.equal(await resolveCopilotAcpRuntime({}, options), null);
  let installs = 0;
  const command = join(root, 'copilot');
  const operations = localProviderOperations('github-copilot', {
    userData: join(root, 'user-data'), copilotRuntimeOptions: options,
    runImpl: async (actual, args) => {
      if (actual === '/bin/bash') { installs += 1; await executable(command); }
      else { assert.equal(actual, command); assert.deepEqual(args, ['--version']); }
      return { stdout: 'Copilot 1.0.95', stderr: '' };
    },
  });
  assert.equal((await operations.detect()).installed, false);
  const installed = await operations.install();
  assert.equal(installed.installed, true);
  assert.equal(installed.installation.ownedByCuppet, true);
  await operations.install();
  assert.equal(installs, 1);
});

test('explicit executable overrides are preserved even when an app runtime is available', unix, async (t) => {
  const { root, options, bundled } = await setup(t);
  await executable(bundled());
  const command = await executable(join(root, 'custom-copilot'));
  assert.deepEqual(await resolveCopilotAcpRuntime({ cliCommand: command }, options), { command, source: 'unknown' });
  assert.equal(await resolveCopilotAcpRuntime({ cliCommand: join(root, 'missing') }, options), null);
  assert.deepEqual(await resolveCopilotAcpRuntime({}, {
    ...options, environment: { ...options.environment, CUPPET_COPILOT_BIN: command },
  }), { command, source: 'unknown' });
});

test('ACP verification rejects incompatible responses and hung runtimes', unix, async (t) => {
  const { root, options } = await setup(t);
  const incompatible = await executable(join(root, 'incompatible'), '#!/bin/sh\nread request\nprintf \'{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":99,"agentCapabilities":{}}}\\n\'\n');
  assert.equal(await verifyCopilotAcpExecutable(incompatible, options.environment, { timeoutMs: 100 }), false);
  const hung = await executable(join(root, 'hung'), '#!/bin/sh\nread request\nread another\n');
  assert.equal(await verifyCopilotAcpExecutable(hung, options.environment, { timeoutMs: 100 }), false);
});

test('an unstarted Copilot session can be closed without spawning discovery', async () => {
  let calls = 0;
  const runtime = new AcpSessionRuntime({
    descriptor: localCliDescriptor('github-copilot'),
    resolveCopilotRuntimeImpl: async () => { calls += 1; return null; },
  });
  await runtime.close();
  assert.equal(calls, 0);
  assert.equal(runtime.snapshot().state, 'closed');
});

test('missing Copilot runtime reports reconnect and closes safely', async () => {
  const runtime = new AcpSessionRuntime({
    descriptor: localCliDescriptor('github-copilot'), resolveCopilotRuntimeImpl: async () => null,
  });
  await assert.rejects(() => runtime.start(), { code: 'PROVIDER_EXECUTABLE_MISSING' });
  await runtime.close();
});
