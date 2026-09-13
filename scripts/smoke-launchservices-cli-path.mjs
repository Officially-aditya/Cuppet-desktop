import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const requestedApp = appArgument(process.argv.slice(2));
const appPath = requestedApp || installedElectronApp();
const tempRoot = await mkdtemp(join(tmpdir(), 'cuppet-launchservices-path-'));
const fakeBin = join(tempRoot, 'login-bin');
const fakeHome = join(tempRoot, 'home');
const fakeShell = join(tempRoot, 'login-shell');
const fakeOpenCode = join(fakeBin, 'opencode');
const resultPath = join(tempRoot, 'result.json');
const launchdPath = '/usr/bin:/bin:/usr/sbin:/sbin';

if (process.platform !== 'darwin') throw new Error('LaunchServices CLI PATH smoke is macOS-only.');
await access(appPath);
await Promise.all([
  mkdir(fakeBin, { recursive: true }),
  mkdir(fakeHome, { recursive: true }),
]);

await writeFile(fakeShell, `#!/bin/sh\nprintf '%s\\n' '__CUPPET_LOGIN_SHELL_PATH__=${fakeBin}:/usr/bin:/bin'\n`, { mode: 0o700 });
await writeFile(fakeOpenCode, `#!/bin/sh\ncase "$1" in\n  --version) printf '%s\\n' 'opencode 99.0.0-cuppet-gui-smoke'; exit 0 ;;\n  auth)\n    if [ "$2" = 'list' ]; then\n      printf '%s\\n' 'Credentials' '● cuppet-gui-smoke'; exit 0\n    fi\n    ;;\nesac\nprintf '%s\\n' "unexpected fake opencode invocation: $*" >&2\nexit 64\n`, { mode: 0o700 });
await chmod(fakeShell, 0o700);
await chmod(fakeOpenCode, 0o700);

try {
  const args = ['-W', '-n', appPath];
  if (!requestedApp) args.push('--args', root);
  const launchEnvironment = {
    PATH: launchdPath,
    SHELL: fakeShell,
    HOME: fakeHome,
    TMPDIR: process.env.TMPDIR || '/tmp',
    USER: process.env.USER || 'runner',
    LOGNAME: process.env.LOGNAME || process.env.USER || 'runner',
    LANG: process.env.LANG || 'en_US.UTF-8',
    CUPPET_INTERNAL_GUI_CLI_SMOKE: '1',
    CUPPET_INTERNAL_GUI_CLI_SMOKE_RESULT: resultPath,
  };
  await execFileAsync('/usr/bin/open', args, {
    env: launchEnvironment,
    timeout: 45_000,
    maxBuffer: 256 * 1024,
  });

  const result = JSON.parse(await readFile(resultPath, 'utf8'));
  assert.equal(result.ok, true, `runtime-owned provider probe failed: ${JSON.stringify(result)}`);
  assert.equal(result.installed, true);
  assert.equal(result.connected, true);
  const [actualExecutable, expectedExecutable] = await Promise.all([
    realpath(String(result.executable || '')),
    realpath(fakeOpenCode),
  ]);
  assert.equal(actualExecutable, expectedExecutable, 'runtime resolved a CLI outside recovered login PATH');
  const recoveredPath = String(result.path || '').split(':');
  assert.equal(await realpath(recoveredPath[0]), await realpath(fakeBin), 'recovered login-shell PATH was not preferred');
  assert.ok(!launchdPath.split(':').includes(fakeBin), 'test setup accidentally put fake CLI in launchd PATH');

  console.log(`[launchservices-smoke] app=${appPath}`);
  console.log(`[launchservices-smoke] launchdPath=${launchdPath}`);
  console.log(`[launchservices-smoke] executable=${actualExecutable}`);
  console.log('[launchservices-smoke] PASS: LaunchServices with launchd-style env -> bootstrap login PATH recovery -> runtime child -> runtime provider control plane resolved authenticated OpenCode.');
} finally {
  await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
}

function installedElectronApp() {
  let executable;
  try {
    executable = require('electron');
  } catch (error) {
    throw new Error(`Electron executable is unavailable after dependency installation: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof executable !== 'string' || !executable.trim()) throw new Error('Electron package did not return its executable path.');
  let current = resolve(executable);
  while (current !== dirname(current)) {
    if (current.endsWith('.app')) return current;
    current = dirname(current);
  }
  throw new Error(`Could not derive Electron.app from installed executable: ${executable}`);
}

function appArgument(args) {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--app') return normalizeApp(args[index + 1]);
    if (value?.startsWith('--app=')) return normalizeApp(value.slice('--app='.length));
  }
  return '';
}

function normalizeApp(value) {
  const app = typeof value === 'string' ? value.trim() : '';
  if (!app) throw new Error('--app requires a .app bundle path.');
  const resolved = resolve(app);
  if (!resolved.endsWith('.app')) throw new Error(`Expected a .app bundle, received ${resolved}`);
  return resolved;
}
