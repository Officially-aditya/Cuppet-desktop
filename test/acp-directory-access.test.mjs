import test from 'node:test';
import assert from 'node:assert/strict';
import { AcpRpcChannel } from '../src/runtime/providers/transports/acp/acp-rpc.mjs';
import { SupervisedAcpSessionRuntime, canRebuildBeforeTurn } from '../src/runtime/providers/transports/acp/supervised-acp-runtime.mjs';
import { providerFailureMetadata } from '../src/runtime/providers/provider-failure.mjs';
import { classifyProviderError } from '../src/runtime/provider-error.mjs';
import { runProviderCommand } from '../src/runtime/providers/cli-command.mjs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';

test('ACP cwd denial preserves the directory and stops the supervisor from respawning', async () => {
  let exit;
  let starts = 0;
  const runtime = new SupervisedAcpSessionRuntime({}, {
    sleep: async () => { throw new Error('Directory denial must not be retried'); },
    runtimeFactory: () => {
      starts += 1;
      const processHandle = {
        cwd: '/Users/test/Downloads/thequery',
        onLine() {}, onExit(handler) { exit = handler; },
        stderr: () => 'Error: EPERM: process.cwd failed with error operation not permitted, uv_cwd at /$bunfs/root/chunk.js:2:450',
        write: () => queueMicrotask(() => exit({ code: 1, signal: null, expected: false })),
        async close() {},
      };
      const rpc = new AcpRpcChannel({ processHandle, label: 'OpenCode' });
      return {
        start: () => rpc.request('initialize', { protocolVersion: 1 }, 500),
        close: () => rpc.close(), snapshot: () => ({ state: 'error' }),
      };
    },
  });
  try {
    await assert.rejects(() => runtime.start(), error => {
      assert.equal(error.code, 'PROVIDER_PROJECT_ACCESS_DENIED');
      assert.equal(providerFailureMetadata(error).retryable, false);
      assert.equal(providerFailureMetadata(error).action, 'grant_project_access');
      assert.equal(canRebuildBeforeTurn(error), false);
      assert.equal(classifyProviderError(error, { providerID: 'opencode' }).title, 'Downloads access required');
      return true;
    });
    assert.equal(starts, 1);
    assert.equal(runtime.snapshot().supervisor.restarts, 0);
  } finally { await runtime.close(); }
});

test('CLI probes use a safe cwd and still honor an explicitly requested directory', async () => {
  const args = ['-e', 'process.stdout.write(process.cwd())'];
  const automatic = await runProviderCommand(process.execPath, args, 3_000);
  assert.equal(automatic.stdout, await realpath(tmpdir()));
  const explicit = await runProviderCommand(process.execPath, args, 3_000, { cwd: process.cwd() });
  assert.equal(explicit.stdout, await realpath(process.cwd()));
});
