import test from 'node:test';
import assert from 'node:assert/strict';
import { localCliDescriptor } from '../src/runtime/local-cli-descriptors.mjs';
import { verifyLocalProviderExecutableVersion } from '../src/runtime/providers/local-provider-version-check.mjs';

test('OpenCode execution preflight rejects a binary below the tested floor', async () => {
  const descriptor = localCliDescriptor('opencode');
  const calls = [];
  await assert.rejects(() => verifyLocalProviderExecutableVersion(descriptor, { cliCommand: '/custom/opencode' }, {
    runVersionImpl: async (command, args) => {
      calls.push({ command, args });
      return { stdout: 'opencode 1.18.29\n', stderr: '' };
    },
  }), (error) => {
    assert.equal(error.code, 'PROVIDER_VERSION_UNSUPPORTED');
    assert.match(error.message, /1\.18\.30/);
    return true;
  });
  assert.deepEqual(calls, [{ command: '/custom/opencode', args: ['--version'] }]);
});

test('OpenCode execution preflight accepts the tested floor and newer versions', async () => {
  const descriptor = localCliDescriptor('opencode');
  for (const version of ['opencode 1.18.30', 'OpenCode 2.0.0']) {
    const result = await verifyLocalProviderExecutableVersion(descriptor, {}, {
      runVersionImpl: async () => ({ stdout: `${version}\n`, stderr: '' }),
    });
    assert.equal(result.supported, true);
    assert.equal(result.state, 'compatible');
  }
});

test('providers without a minimum policy do not execute a version subprocess', async () => {
  const descriptor = localCliDescriptor('kiro');
  let calls = 0;
  const result = await verifyLocalProviderExecutableVersion(descriptor, {}, {
    runVersionImpl: async () => {
      calls += 1;
      return { stdout: 'kiro-cli 99.0.0', stderr: '' };
    },
  });
  assert.equal(result, null);
  assert.equal(calls, 0);
});

test('execution preflight uses explicit CLI command before descriptor defaults', async () => {
  const descriptor = localCliDescriptor('opencode');
  let observed = null;
  await verifyLocalProviderExecutableVersion(descriptor, { cliCommand: '/opt/cuppet/opencode' }, {
    runVersionImpl: async (command, args) => {
      observed = { command, args };
      return { stdout: '1.18.30', stderr: '' };
    },
  });
  assert.deepEqual(observed, { command: '/opt/cuppet/opencode', args: ['--version'] });
});

test('execution preflight wraps ENOENT as PROVIDER_EXECUTABLE_MISSING failure', async () => {
  const descriptor = localCliDescriptor('opencode');
  await assert.rejects(() => verifyLocalProviderExecutableVersion(descriptor, { cliCommand: 'nonexistent-bin' }, {
    runVersionImpl: async () => {
      const err = new Error('spawn nonexistent-bin ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
  }), (error) => {
    assert.equal(error.code, 'PROVIDER_EXECUTABLE_MISSING');
    assert.match(error.message, /CLI was not found/);
    return true;
  });
});
