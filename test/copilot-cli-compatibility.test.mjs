import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCopilotAcpRuntime, verifyCopilotAcpExecutable } from '../src/runtime/copilot-acp-runtime.mjs';
import { deleteCopilotSessions } from '../src/runtime/providers/session-cleanup.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-copilot-launch.mjs', import.meta.url));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

for (const flavor of ['legacy', 'modern']) {
  test(`Copilot ${flavor} CLI starts and cleans up with supported flags and sync disabled`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'cuppet-copilot-compat-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const command = join(root, process.platform === 'win32' ? 'copilot.cmd' : 'copilot');
    await writeFile(command, process.platform === 'win32'
      ? `@"${process.execPath}" "${fixture}" %*\r\n`
      : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`);
    await chmod(command, 0o755);
    const environment = { ...process.env, TEST_COPILOT_FLAVOR: flavor, TEST_COPILOT_LOG: join(root, 'deleted'), ELECTRON_RUN_AS_NODE: '1' };
    const runtime = await resolveCopilotAcpRuntime({ cliCommand: command }, { environment });
    assert.equal(runtime.command, command);
    assert.ok(runtime.args.includes(flavor === 'modern' ? '--sync-session=off' : '--no-remote-export'));
    await deleteCopilotSessions({ command, environment, records: [{ sessionId: 'owned-session' }] });
    assert.equal(await readFile(environment.TEST_COPILOT_LOG, 'utf8'), 'owned-session\n');
    const failed = await resolveCopilotAcpRuntime({ cliCommand: command }, { environment: { ...environment, TEST_COPILOT_FAIL: '1' }, allowUnverified: true });
    assert.equal(failed.command, command);
    assert.match(failed.error, /Copilot launch diagnostic: incompatible option/);
    const coldFile = join(root, 'cold-starts');
    assert.equal(await verifyCopilotAcpExecutable(command, { ...environment, TEST_COPILOT_COLD_FILE: coldFile }, { timeoutMs: process.platform === 'win32' ? 2000 : 250, throwOnError: true }), true);
    assert.equal(await readFile(coldFile, 'utf8'), '2', 'a timed-out initialization must get one fresh process and a longer deadline');
  });
}
