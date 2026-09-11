import assert from 'node:assert/strict';
import test from 'node:test';
import { installSpec, loginSpec } from '../src/main/cli-agent-status.mjs';

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
