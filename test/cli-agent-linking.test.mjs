import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installSpec, loginSpec } from '../src/main/cli-agent-status.mjs';
import { localProviderOperations } from '../src/main/local-provider-operations.mjs';

const providers = ['opencode', 'grok-build', 'github-copilot', 'mistral-vibe', 'kiro', 'antigravity'];

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

test('Cuppet records ownership only after its explicit installer succeeds', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'cuppet-provider-ops-'));
  let installed = false;
  const calls = [];
  const runImpl = async (command, args) => {
    calls.push([command, [...args]]);
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

test('Cuppet revokes ownership when PATH resolves to a different executable identity', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'cuppet-provider-identity-'));
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
