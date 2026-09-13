import assert from 'node:assert/strict';
import test from 'node:test';
import { cliAgentStatus } from '../src/main/cli-agent-status.mjs';
import { parseOpenCodeAuthList } from '../src/runtime/providers/opencode-auth.mjs';

test('OpenCode auth parser rejects a successful zero-credential listing', () => {
  const parsed = parseOpenCodeAuthList(`
┌  Credentials ~/.local/share/opencode/auth.json
│
└  0 credentials
`);
  assert.deepEqual(parsed, {
    connected: false,
    source: 'none',
    credentialCount: 0,
    environmentCount: 0,
  });
});

test('OpenCode auth parser accepts stored credentials', () => {
  const parsed = parseOpenCodeAuthList(`
┌  Credentials ~/.local/share/opencode/auth.json
│
●  OpenCode Zen api
│
●  OpenAI oauth
│
└  2 credentials
`);
  assert.equal(parsed.connected, true);
  assert.equal(parsed.source, 'credentials');
  assert.equal(parsed.credentialCount, 2);
});

test('OpenCode auth parser accepts provider credentials supplied by environment', () => {
  const parsed = parseOpenCodeAuthList(`
┌  Credentials ~/.local/share/opencode/auth.json
│
└  0 credentials

┌  Environment
│
●  GitHub Copilot GITHUB_TOKEN
│
└  1 environment variables
`);
  assert.equal(parsed.connected, true);
  assert.equal(parsed.source, 'environment');
  assert.equal(parsed.environmentCount, 1);
});

test('OpenCode settings status no longer trusts CLI presence alone', async () => {
  const calls = [];
  const runImpl = async (_command, args) => {
    calls.push([...args]);
    if (args[0] === '--version' || args[0] === 'version') return { stdout: 'opencode 1.18.30\n', stderr: '' };
    if (args[0] === 'auth' && args[1] === 'list') {
      return { stdout: '┌  Credentials ~/.local/share/opencode/auth.json\n│\n└  0 credentials\n', stderr: '' };
    }
    return { stdout: 'opencode 1.18.30\n', stderr: '' };
  };

  const status = await cliAgentStatus('opencode', { runImpl, platform: 'darwin' });
  assert.equal(status.installed, true);
  assert.equal(status.connected, false);
  assert.equal(status.available, false);
  assert.equal(status.action, 'connect');
  assert.match(status.message, /no authenticated provider credentials/i);
  assert.ok(calls.some((args) => args[0] === 'auth' && args[1] === 'list'));
});

test('OpenCode settings status becomes connected only after auth list proves credentials', async () => {
  const runImpl = async (_command, args) => {
    if (args[0] === 'auth' && args[1] === 'list') {
      return { stdout: '┌  Credentials ~/.local/share/opencode/auth.json\n│\n●  OpenAI oauth\n│\n└  1 credential\n', stderr: '' };
    }
    return { stdout: 'opencode 1.18.30\n', stderr: '' };
  };

  const status = await cliAgentStatus('opencode', { runImpl, platform: 'darwin' });
  assert.equal(status.connected, true);
  assert.equal(status.available, true);
  assert.equal(status.action, 'ready');
});
