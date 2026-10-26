import assert from 'node:assert/strict';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { installSpec, loginSpec } from '../src/main/cli-agent-status.mjs';
import { localProviderOperations } from '../src/main/local-provider-operations.mjs';

test('connecting an already installed provider does not run its installer or login again', async () => {
  const calls = [];
  const operations = localProviderOperations('claude-code', {
    runImpl: async (command, args) => { calls.push(args); return { stdout: '1.0.0', stderr: '' }; },
  });
  const status = await operations.connect();
  assert.equal(status.connected, true);
  assert.ok(calls.every((args) => args.includes('--version') || args.includes('status')));
});

test('Connect still installs a missing Claude ACP adapter automatically', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cuppet-missing-adapter-')));
  const command = join(root, 'claude-agent-acp');
  const previous = process.env.CUPPET_CLAUDE_ACP_BIN;
  process.env.CUPPET_CLAUDE_ACP_BIN = command;
  t.after(async () => {
    if (previous === undefined) delete process.env.CUPPET_CLAUDE_ACP_BIN;
    else process.env.CUPPET_CLAUDE_ACP_BIN = previous;
    await rm(root, { recursive: true, force: true });
  });
  let installed = false;
  let installs = 0;
  const operations = localProviderOperations('claude-code', {
    userData: join(root, 'state'), platform: 'darwin',
    runImpl: async (actual, args) => {
      if (actual === '/bin/bash') {
        assert.match(args[1], /npm install -g @agentclientprotocol\/claude-agent-acp/);
        installs += 1;
        await writeFile(command, '#!/bin/sh\nexit 0\n');
        await chmod(command, 0o755);
        installed = true;
      } else {
        assert.equal(actual, command);
        if (!installed) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      }
      return { stdout: '1.0.0', stderr: '' };
    },
  });
  const missing = await operations.status();
  assert.equal(missing.installed, false);
  assert.equal(missing.missingAdapter, 'claude-agent-acp');
  assert.match(missing.message, /install the adapter automatically/);
  const connected = await operations.connect();
  assert.equal(connected.installed, true);
  assert.equal(connected.connected, true);
  assert.equal(connected.missingAdapter, undefined);
  assert.equal(installs, 1);
  await operations.connect();
  assert.equal(installs, 1);
});

test('an existing CLI with an unavailable interpreter remains installed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cuppet-cli-interpreter-'));
  const command = join(root, 'claude-agent-acp');
  await writeFile(command, '#!/missing/interpreter\n');
  await chmod(command, 0o755);
  const previous = process.env.CUPPET_CLAUDE_ACP_BIN;
  process.env.CUPPET_CLAUDE_ACP_BIN = command;
  t.after(async () => {
    if (previous === undefined) delete process.env.CUPPET_CLAUDE_ACP_BIN;
    else process.env.CUPPET_CLAUDE_ACP_BIN = previous;
    await rm(root, { recursive: true, force: true });
  });
  const operations = localProviderOperations('claude-code', {
    runImpl: async () => { throw Object.assign(new Error('interpreter not found'), { code: 'ENOENT' }); },
  });
  const detected = await operations.detect();
  assert.equal(detected.installed, true);
  assert.match(detected.error, /interpreter not found/);
  assert.equal(detected.missingAdapter, undefined);
});

test('Antigravity detection is read-only and Connect verifies the same ACP runtime used for chat', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'cuppet-agy-connect-'));
  const fixture = fileURLToPath(new URL('./fixtures/fake-acp-config-agent.mjs', import.meta.url));
  const calls = [];
  const installation = { command: process.execPath, args: [fixture], harnessPath: fixture, source: 'native' };
  const operations = localProviderOperations('antigravity', {
    userData,
    runImpl: async () => { throw new Error('agy CLI should not run'); },
    resolveAntigravityInstallationImpl: async (_, options) => { calls.push(options); return installation; },
  });
  try {
    assert.equal((await operations.detect()).installed, true);
    assert.equal((await operations.probe()).connected, true);
    assert.ok(calls.every((options) => options.allowInstall === false));
    const status = await operations.connect();
    assert.equal(status.connected, true);
    assert.equal(status.installation.executable, process.execPath);
    assert.equal(status.installation.source, 'native');
    assert.equal(status.installation.ownedByCuppet, false);
    assert.ok(calls.every((options) => options.allowInstall === false));
  } finally { await rm(userData, { recursive: true, force: true }); }
});

test('Antigravity installs only its missing ACP runtime', async () => {
  let installed = false;
  let installs = 0;
  const operations = localProviderOperations('antigravity', {
    runImpl: async () => { throw new Error('agy CLI should not run'); },
    resolveAntigravityInstallationImpl: async (_, options) => {
      if (options.allowInstall === false) return installed ? { command: process.execPath, source: 'managed' } : null;
      installed = true;
      installs += 1;
    },
  });
  assert.equal((await operations.detect()).installed, false);
  assert.equal((await operations.install()).installed, true);
  await operations.install();
  assert.equal(installs, 1);
  await assert.rejects(() => operations.update(), /ACP runtime updates are delivered with Cuppet releases/);
  assert.equal(installs, 1);
});

const providers = ['opencode', 'claude-code', 'grok-build', 'github-copilot', 'mistral-vibe', 'kiro', 'antigravity'];

test('all local providers have automatic macOS installers', () => {
  for (const providerID of providers) {
    const spec = installSpec(providerID, 'darwin');
    assert.ok(spec, `missing automatic installer for ${providerID}`);
    assert.equal(spec.command, '/bin/bash');
    assert.deepEqual(spec.args.slice(0, 1), ['-lc']);
  }
});

test('Antigravity uses the canonical installer without stale installer flags', () => {
  const spec = installSpec('antigravity', 'darwin');
  assert.equal(spec.command, '/bin/bash');
  assert.equal(spec.args[0], '-lc');
  assert.equal(spec.args[1], 'curl -fsSL https://antigravity.google/cli/install.sh | bash');
  assert.ok(!spec.args[1].includes('--skip-path'));
  assert.ok(!spec.args[1].includes('--skip-aliases'));
});

test('provider-owned login flows need no copied Terminal command', () => {
  assert.equal(loginSpec('opencode', 'opencode'), null);
  assert.deepEqual(loginSpec('claude-code', 'claude-agent-acp').args, ['--cli', 'auth', 'login']);
  assert.deepEqual(loginSpec('grok-build', 'grok').args, ['login']);
  assert.deepEqual(loginSpec('github-copilot', 'copilot').args, ['login', '--web-flow']);
  assert.deepEqual(loginSpec('kiro', 'kiro-cli').args, ['login', '--license', 'free']);
  const vibe = loginSpec('mistral-vibe', '/tmp/vibe-acp');
  assert.equal(vibe.command, '/tmp/vibe');
  assert.deepEqual(vibe.args, ['--setup']);
  const antigravity = loginSpec('antigravity', 'agy');
  assert.ok(antigravity.args.includes('--mode=plan'));
  assert.ok(antigravity.args.includes('--sandbox'));
  assert.ok(!antigravity.args.includes('--dangerously-skip-permissions'));
});

test('detect and probe remain read-only and never launch provider login', async () => {
  const calls = [];
  const runImpl = async (command, args) => {
    calls.push([command, [...args]]);
    if (args.includes('status')) throw new Error('not authenticated');
    return { stdout: 'claude-agent-acp 1.0.0\n', stderr: '' };
  };
  const operations = localProviderOperations('claude-code', { runImpl, platform: 'darwin' });

  const detected = await operations.detect();
  assert.equal(detected.installed, true);
  assert.equal(calls.length, 1);
  assert.ok(!calls.some(([, args]) => args.includes('login')));
  assert.ok(!calls.some(([command]) => command === '/bin/bash'));

  const probed = await operations.probe();
  assert.equal(probed.connected, false);
  assert.ok(calls.some(([, args]) => args.includes('status')));
  assert.ok(!calls.some(([, args]) => args.includes('login')));
  assert.ok(!calls.some(([command]) => command === '/bin/bash'));
});

test('Cuppet records ownership only after its explicit installer succeeds', async (t) => {
  const userData = await mkdtemp(join(tmpdir(), 'cuppet-provider-ops-'));
  const executable = join(userData, 'opencode');
  const previous = process.env.CUPPET_OPENCODE_BIN;
  process.env.CUPPET_OPENCODE_BIN = executable;
  t.after(() => {
    if (previous === undefined) delete process.env.CUPPET_OPENCODE_BIN;
    else process.env.CUPPET_OPENCODE_BIN = previous;
  });
  let installed = false;
  const calls = [];
  const runImpl = async (command, args) => {
    calls.push([command, [...args]]);
    if (command === '/bin/bash') {
      await writeFile(executable, '#!/bin/sh\nexit 0\n');
      await chmod(executable, 0o755);
      installed = true;
      return { stdout: '', stderr: '' };
    }
    if (!installed) {
      const error = new Error('ENOENT');
      error.code = 'ENOENT';
      throw error;
    }
    return { stdout: 'opencode 9.9.9\n', stderr: '' };
  };
  try {
    const operations = localProviderOperations('opencode', { userData, runImpl, platform: 'darwin', now: () => 1234 });
    const before = await operations.detect();
    assert.equal(before.installed, false);
    assert.equal(before.installation.ownedByCuppet, false);

    const after = await operations.install();
    assert.equal(after.installed, true);
    assert.equal(after.installation.ownedByCuppet, true);
    assert.equal(after.installation.source, 'managed');
    assert.equal(after.installation.canUpdate, true);
    assert.ok(calls.some(([command]) => command === '/bin/bash'));
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});

test('Cuppet revokes ownership when PATH resolves to a different executable identity', async (t) => {
  const userData = await mkdtemp(join(tmpdir(), 'cuppet-provider-identity-'));
  const previous = process.env.CUPPET_OPENCODE_BIN;
  process.env.CUPPET_OPENCODE_BIN = join(userData, 'opencode');
  t.after(() => {
    if (previous === undefined) delete process.env.CUPPET_OPENCODE_BIN;
    else process.env.CUPPET_OPENCODE_BIN = previous;
  });
  let installed = false;
  let identity = {
    resolvedPath: '/managed/opencode',
    realPath: '/managed/opencode',
    dev: 1,
    ino: 10,
    size: 100,
    mtimeMs: 1000,
  };
  const runImpl = async (command) => {
    if (command === '/bin/bash') {
      installed = true;
      return { stdout: '', stderr: '' };
    }
    if (!installed) {
      const error = new Error('ENOENT');
      error.code = 'ENOENT';
      throw error;
    }
    return { stdout: 'opencode 9.9.9\n', stderr: '' };
  };
  try {
    const operations = localProviderOperations('opencode', {
      userData,
      runImpl,
      platform: 'darwin',
      now: () => 1234,
      executableIdentityImpl: async () => identity,
    });
    const installedState = await operations.install();
    assert.equal(installedState.installation.ownedByCuppet, true);
    assert.equal(installedState.installation.identity.realPath, '/managed/opencode');

    identity = {
      resolvedPath: '/external/opencode',
      realPath: '/external/opencode',
      dev: 2,
      ino: 20,
      size: 200,
      mtimeMs: 2000,
    };
    const replaced = await operations.detect();
    assert.equal(replaced.installation.ownedByCuppet, false);
    assert.equal(replaced.installation.source, 'unknown');
    assert.equal(replaced.installation.canUpdate, false);
    await assert.rejects(() => operations.update(), /does not own this OpenCode installation/);
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});

test('discovered external installs never inherit update authority', async () => {
  const calls = [];
  const runImpl = async (command, args) => {
    calls.push([command, [...args]]);
    return { stdout: 'opencode 1.0.0\n', stderr: '' };
  };
  const operations = localProviderOperations('opencode', { runImpl, platform: 'darwin' });
  const detected = await operations.detect();
  assert.equal(detected.installed, true);
  assert.equal(detected.installation.source, 'unknown');
  assert.equal(detected.installation.ownedByCuppet, false);
  assert.equal(detected.installation.canUpdate, false);
  await assert.rejects(() => operations.update(), /does not own this OpenCode installation/);
  assert.ok(!calls.some(([command]) => command === '/bin/bash'));
});

test('Windows provider detection handles "not recognized" cmd errors as uninstalled without error', async (t) => {
  const previous = process.env.CUPPET_OPENCODE_BIN;
  process.env.CUPPET_OPENCODE_BIN = join(tmpdir(), `missing-opencode-${process.pid}.cmd`);
  t.after(() => { if (previous === undefined) delete process.env.CUPPET_OPENCODE_BIN; else process.env.CUPPET_OPENCODE_BIN = previous; });
  const runImpl = async () => {
    throw new Error("'opencode' is not recognized as an internal or external command,\r\noperable program or batch file.");
  };
  const operations = localProviderOperations('opencode', { runImpl, platform: 'win32' });
  const detected = await operations.detect();
  assert.equal(detected.installed, false);
  assert.equal(detected.error, null);
  assert.equal(detected.installation.detected, false);
});

test('Windows npm installers use batch launchers, verify results and propagate failures', () => {
  const opencodeSpec = installSpec('opencode', 'win32');
  assert.ok(opencodeSpec);
  assert.match(opencodeSpec.args.join(' '), /Get-Command opencode/);
  assert.match(opencodeSpec.args.join(' '), /install -g opencode-ai --force/);

  const claudeSpec = installSpec('claude-code', 'win32');
  assert.ok(claudeSpec);
  assert.match(claudeSpec.args.join(' '), /Get-Command npm.cmd/);
  assert.match(claudeSpec.args.join(' '), /install -g @agentclientprotocol\/claude-agent-acp --force/);
  for (const id of providers) {
    const spec = installSpec(id, 'win32');
    assert.match(spec.args.at(-1), /catch.*exit 1/s);
  }
  const copilotSpec = installSpec('github-copilot', 'win32');
  assert.match(copilotSpec.args.at(-1), /@github\/copilot --ignore-scripts=false/);
  assert.match(copilotSpec.args.at(-1), /winget install/);
  assert.match(claudeSpec.args.at(-1), /__CUPPET_INSTALLED_CLI__/);
});
