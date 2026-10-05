import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const executable = resolve(process.argv[2] || defaultExecutable());
const resources = process.platform === 'darwin'
  ? resolve(dirname(executable), '..', 'Resources')
  : join(dirname(executable), 'resources');
await access(executable);
await access(join(resources, 'app.asar'));
await access(join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty', 'package.json'));

// Use the packaged Electron runtime and manager so missing native binaries,
// helper paths inside ASAR, and a silent fallback to shell pipes all fail here.
const smoke = String.raw`
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { ProjectTerminalManager } = await import(pathToFileURL(join(process.cwd(), 'app.asar', 'src', 'main', 'project-terminal-manager.mjs')));
const manager = new ProjectTerminalManager({ request: async () => null });
let output = '';
let resolveOutput;
let rejectOutput;
const received = new Promise((resolve, reject) => { resolveOutput = resolve; rejectOutput = reject; });
const timer = setTimeout(() => rejectOutput(new Error('Packaged terminal did not execute the command: ' + output)), 15_000);
const owner = {
  id: 1,
  send(_channel, event) {
    if (event.type === 'output') {
      output += event.data;
    } else if (event.type === 'exit') {
      if (event.code === 0 && output.includes(process.env.CUPPET_TERMINAL_SMOKE_TOKEN)) resolveOutput();
      else rejectOutput(new Error('Packaged terminal exited without successful command output: ' + output));
    } else if (event.type === 'error') {
      rejectOutput(new Error(event.message || 'Packaged terminal failed'));
    }
  },
};
try {
  const session = await manager.start(owner, 'default', { cols: 80, rows: 24 });
  assert.equal(manager.resize(owner, session.sessionId, 100, 30).resized, true, 'packaged terminal fell back to non-interactive shell pipes');
  const command = /(?:powershell|pwsh)\.exe$/i.test(session.shell)
    ? 'echo $env:CUPPET_TERMINAL_SMOKE_TOKEN\r'
    : /cmd\.exe$/i.test(session.shell)
      ? 'echo %CUPPET_TERMINAL_SMOKE_TOKEN%\r'
      : 'printf "%s\\n" "$CUPPET_TERMINAL_SMOKE_TOKEN"\r';
  manager.write(owner, session.sessionId, command + 'exit\r');
  await received;
  console.log('Packaged interactive terminal smoke passed: ' + session.shell);
} finally {
  clearTimeout(timer);
  manager.stopAll();
}
`;

const result = spawnSync(executable, ['--input-type=module', '--eval', smoke], {
  cwd: resources,
  env: {
    ...process.env,
    // Keep Unix shell startup independent of the developer's shell plugins.
    ...(process.platform === 'win32' ? {} : { SHELL: '/bin/sh' }),
    ELECTRON_RUN_AS_NODE: '1',
    CUPPET_TERMINAL_SMOKE_TOKEN: randomUUID(),
  },
  stdio: 'inherit',
  windowsHide: true,
  timeout: 30_000,
});
if (result.error) throw result.error;
assert.equal(result.status, 0, `Packaged terminal smoke failed (${result.signal || result.status})`);

function defaultExecutable() {
  if (process.platform === 'win32') return join(root, 'dist', 'win-unpacked', 'cuppet.exe');
  if (process.platform === 'darwin') return join(root, 'dist', 'mac-arm64', 'Cuppet.app', 'Contents', 'MacOS', 'cuppet');
  return join(root, 'dist', 'linux-unpacked', 'cuppet');
}
