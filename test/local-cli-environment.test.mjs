import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { detectLocalProviderApp, localCliEnvironment, resolveLocalCliExecutable, resolveWindowsPowerShell } from '../src/runtime/local-cli-environment.mjs';

test('Antigravity app discovery supports both macOS executable names', () => {
  for (const executable of ['Antigravity', 'Electron']) {
    const app = detectLocalProviderApp('antigravity', {}, {
      platform: 'darwin', home: '/Users/cuppet-test',
      accessSyncImpl: (path) => {
        if (path !== `/Applications/Antigravity.app/Contents/MacOS/${executable}`) throw new Error('missing');
      },
    });
    assert.deepEqual(app, { label: 'Google Antigravity', path: '/Applications/Antigravity.app' });
  }
});

test('official apps are detected separately from their provider runtime', () => {
  for (const [providerID, product, label] of [
    ['github-copilot', 'Microsoft VS Code', 'Visual Studio Code'],
    ['antigravity', 'Antigravity', 'Google Antigravity'],
  ]) {
    const expected = `C:\\Users\\test\\AppData\\Local\\Programs\\${product}`;
    const app = detectLocalProviderApp(providerID, { LocalAppData: 'C:\\Users\\test\\AppData\\Local' }, {
      platform: 'win32', home: 'C:\\Users\\test',
      accessSyncImpl: (path) => { if (path !== `${expected}\\${providerID === 'github-copilot' ? 'Code.exe' : 'Antigravity.exe'}`) throw new Error('missing'); },
    });
    assert.deepEqual(app, { label, path: expected });
  }
  assert.equal(detectLocalProviderApp('github-copilot', {}, {
    platform: 'win32', accessSyncImpl: () => { throw new Error('missing'); },
  }), null);
});

const bootstrapPath = fileURLToPath(new URL('../src/main/bootstrap.mjs', import.meta.url));

test('macOS local CLI environment prefers login-shell PATH over launchd PATH', () => {
  let probes = 0;
  const environment = localCliEnvironment({
    HOME: '/Users/cuppet-test',
    SHELL: '/bin/zsh',
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  }, {
    platform: 'darwin',
    home: '/Users/cuppet-test',
    loginPathProbe: () => {
      probes += 1;
      return '/Users/cuppet-test/.nvm/versions/node/v22/bin:/opt/homebrew/bin:/usr/bin:/bin';
    },
  });

  const entries = environment.PATH.split(':');
  assert.equal(probes, 1);
  assert.equal(entries[0], '/Users/cuppet-test/.nvm/versions/node/v22/bin');
  assert.equal(entries[1], '/opt/homebrew/bin');
  assert.equal(entries.filter((entry) => entry === '/usr/bin').length, 1);
  assert.ok(entries.includes('/Users/cuppet-test/.opencode/bin'));
  assert.ok(entries.includes('/Users/cuppet-test/.bun/bin'));
});

test('explicit Cuppet CLI paths stay ahead of recovered shell paths', () => {
  const environment = localCliEnvironment({
    HOME: '/Users/cuppet-test',
    SHELL: '/bin/zsh',
    PATH: '/usr/bin:/bin',
    CUPPET_CLI_PATH: '/custom/provider/bin:/another/provider/bin',
  }, {
    platform: 'darwin',
    home: '/Users/cuppet-test',
    loginPathProbe: () => '/Users/cuppet-test/.local/bin:/usr/bin:/bin',
  });

  assert.deepEqual(environment.PATH.split(':').slice(0, 3), [
    '/custom/provider/bin',
    '/another/provider/bin',
    '/Users/cuppet-test/.local/bin',
  ]);
});

test('failed login-shell PATH recovery falls back without breaking CLI lookup', () => {
  const environment = localCliEnvironment({
    HOME: '/Users/cuppet-test',
    PATH: '/usr/bin:/bin',
  }, {
    platform: 'darwin',
    home: '/Users/cuppet-test',
    loginPathProbe: () => { throw new Error('shell profile failed'); },
  });

  const entries = environment.PATH.split(':');
  assert.deepEqual(entries.slice(0, 2), ['/usr/bin', '/bin']);
  assert.ok(entries.includes('/Users/cuppet-test/.opencode/bin'));
  assert.ok(entries.includes('/opt/homebrew/bin'));
});

test('Linux environments recover the login-shell PATH too', () => {
  let probes = 0;
  const environment = localCliEnvironment({ HOME: '/home/cuppet', PATH: '/usr/bin:/bin' }, {
    platform: 'linux',
    home: '/home/cuppet',
    loginPathProbe: () => { probes += 1; return '/home/cuppet/.nvm/versions/node/v22/bin'; },
  });

  assert.equal(probes, 1);
  assert.equal(environment.PATH.split(':')[0], '/home/cuppet/.nvm/versions/node/v22/bin');
  assert.ok(environment.PATH.includes('/home/cuppet/.local/bin'));
});

test('login-shell recovery tries the account shell after the inherited shell fails', () => {
  const calls = [];
  const environment = localCliEnvironment({ SHELL: '/missing/shell', PATH: '/usr/bin' }, {
    platform: 'linux', home: '/home/shell-fallback', userShell: '/bin/account-shell',
    spawnSyncImpl: (command, args, options) => {
      calls.push(command);
      assert.deepEqual(args.slice(0, 3), ['-l', '-i', '-c']);
      assert.equal(options.timeout, 5_000);
      assert.equal(options.detached, true);
      return command === '/missing/shell'
        ? { error: { code: 'ENOENT' }, status: null }
        : { status: 0, stdout: '__CUPPET_CLI_ENV_PATH=/custom/bin:/usr/bin\n__CUPPET_CLI_ENV___MISE_DIFF=version-manager-state\n__CUPPET_CLI_ENV_SECRET=do-not-import\n' };
    },
  });
  assert.deepEqual(calls, ['/missing/shell', '/bin/account-shell']);
  assert.equal(environment.PATH.split(':')[0], '/custom/bin');
  assert.equal(environment.__MISE_DIFF, 'version-manager-state');
  assert.equal(environment.SECRET, undefined);
});

test('failed PATH recovery is retried and successful recovery can be explicitly refreshed', () => {
  let calls = 0;
  let recoveredPath = '';
  const options = {
    platform: 'darwin', home: '/Users/path-retry', userShell: '/bin/zsh',
    spawnSyncImpl: () => {
      calls += 1;
      return recoveredPath
        ? { status: 0, stdout: `__CUPPET_CLI_ENV_PATH=${recoveredPath}\n` }
        : { status: null, error: { code: 'ETIMEDOUT' } };
    },
  };
  const inherited = { SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' };
  assert.equal(localCliEnvironment(inherited, options).PATH.split(':')[0], '/usr/bin');
  const failedCalls = calls;
  recoveredPath = '/new/node/bin';
  assert.equal(localCliEnvironment(inherited, options).PATH.split(':')[0], recoveredPath);
  assert.ok(calls > failedCalls, 'a failed probe must not be cached');
  const successfulCalls = calls;
  recoveredPath = '/new/provider/bin';
  assert.equal(localCliEnvironment(inherited, options).PATH.split(':')[0], '/new/node/bin');
  assert.equal(calls, successfulCalls);
  assert.equal(localCliEnvironment(inherited, { ...options, refresh: true }).PATH.split(':')[0], recoveredPath);
  assert.ok(calls > successfulCalls);
});

test('macOS PATH recovery falls back to launchctl when login shells fail', () => {
  const environment = localCliEnvironment({ PATH: '/usr/bin' }, {
    platform: 'darwin', home: '/Users/launchctl-path', userShell: '/bin/zsh',
    spawnSyncImpl: (command, args) => {
      if (command !== '/bin/launchctl') return { status: 1 };
      assert.deepEqual(args, ['getenv', 'PATH']);
      return { status: 0, stdout: '/custom/launchctl/bin:/usr/bin\n' };
    },
  });
  assert.equal(environment.PATH.split(':')[0], '/custom/launchctl/bin');
});

test('Windows discovery combines profiled PowerShell PATH and version-manager environment', () => {
  const calls = [];
  const environment = localCliEnvironment({ Path: 'C:\\inherited', path: 'C:\\stale' }, {
    platform: 'win32', home: 'C:\\Users\\profile-path',
    spawnSyncImpl: (_command, args) => {
      const noProfile = args.includes('-NoProfile');
      calls.push(noProfile);
      return { status: 0, stdout: noProfile
        ? '__CUPPET_CLI_ENV_PATH=C:\\system\r\n'
        : '__CUPPET_CLI_ENV_PATH=C:\\fnm\\node;C:\\system\r\n__CUPPET_CLI_ENV_FNM_DIR=C:\\fnm\r\n__CUPPET_CLI_ENV_FNM_MULTISHELL_PATH=C:\\fnm\\node\r\n__CUPPET_CLI_ENV_TOKEN=do-not-import\r\n' };
    },
  });
  assert.deepEqual(calls, [true, false]);
  assert.deepEqual(environment.PATH.split(';').slice(0, 3), ['C:\\fnm\\node', 'C:\\system', 'C:\\inherited']);
  assert.equal(environment.Path, environment.PATH);
  assert.equal(environment.path, undefined);
  assert.equal(environment.FNM_DIR, 'C:\\fnm');
  assert.equal(environment.FNM_MULTISHELL_PATH, 'C:\\fnm\\node');
  assert.equal(environment.TOKEN, undefined);
  assert.ok(environment.PATH.includes('C:\\Users\\profile-path\\AppData\\Local\\Volta\\bin'));
});

test('a CLI installed after a missing lookup is immediately discoverable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cuppet-new-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = { PATH: root };
  const options = { environment };
  assert.equal(resolveLocalCliExecutable('new-provider', environment, options), 'new-provider');
  const command = join(root, process.platform === 'win32' ? 'new-provider.exe' : 'new-provider');
  await writeFile(command, 'new provider');
  await chmod(command, 0o755);
  assert.equal(resolveLocalCliExecutable('new-provider', environment, options).toLowerCase(), command.toLowerCase());
});

test('local CLI resolver returns an absolute executable from recovered GUI PATH', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cuppet-provider-bin-'));
  const command = join(root, 'opencode');
  try {
    await writeFile(command, '#!/bin/sh\nexit 0\n');
    await chmod(command, 0o755);
    const environment = localCliEnvironment({ HOME: root, PATH: '/usr/bin:/bin' }, {
      platform: 'darwin',
      home: root,
      loginPathProbe: () => `${root}:/usr/bin:/bin`,
    });
    assert.equal(resolveLocalCliExecutable('opencode', environment, { platform: 'darwin', environment }), command);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('local CLI resolver preserves explicit absolute provider commands', () => {
  assert.equal(resolveLocalCliExecutable('/custom/bin/provider', { PATH: '/usr/bin' }, { platform: 'darwin' }), '/custom/bin/provider');
});

test('desktop bootstrap hydrates CLI PATH before importing the runtime', async () => {
  const source = await readFile(bootstrapPath, 'utf8');
  const hydrateIndex = source.indexOf('applyLocalCliEnvironment();');
  const runtimeImportIndex = source.indexOf("await import('./main.mjs')");
  assert.ok(hydrateIndex >= 0, 'desktop bootstrap must hydrate local CLI environment');
  assert.ok(runtimeImportIndex >= 0, 'desktop bootstrap must import the runtime');
  assert.ok(hydrateIndex < runtimeImportIndex, 'CLI PATH recovery must happen before runtime startup');
});

test('Windows local CLI environment includes system directories and preserves Path alias', () => {
  const env = {
    Path: 'C:\\custom\\bin',
    SystemRoot: 'C:\\Windows',
    ProgramFiles: 'C:\\Program Files',
  };
  const result = localCliEnvironment(env, { platform: 'win32', home: 'C:\\Users\\test' });
  const entries = result.PATH.split(';');
  assert.ok(entries.includes('C:\\custom\\bin'));
  assert.ok(entries.includes('C:\\Windows\\System32\\WindowsPowerShell\\v1.0'));
  assert.ok(entries.includes('C:\\Windows\\System32'));
  assert.ok(entries.includes('C:\\Program Files\\PowerShell\\7'));
  assert.equal(result.Path, result.PATH);
  assert.ok(entries.includes('C:\\Users\\test\\AppData\\Local\\Microsoft\\WinGet\\Links'));
  assert.ok(entries.includes('C:\\Program Files\\WinGet\\Links'));
  assert.ok(entries.includes('C:\\Users\\test\\scoop\\shims'));
  assert.ok(entries.includes('C:\\Program Files\\Kiro-Cli'));
  assert.ok(entries.includes('C:\\Users\\test\\AppData\\Local\\Microsoft\\WindowsApps'));
});

test('resolveWindowsPowerShell resolves absolute path when present or falls back cleanly', () => {
  assert.equal(resolveWindowsPowerShell('darwin'), 'powershell.exe');

  // When candidates exist according to accessSyncImpl
  const resolved = resolveWindowsPowerShell('win32', { SystemRoot: 'C:\\Windows' }, (path) => {
    if (path.includes('WindowsPowerShell')) return;
    throw new Error('not found');
  });
  assert.match(resolved, /WindowsPowerShell[/\\]v1\.0[/\\]powershell\.exe/);

  // When no candidates exist, falls back to powershell.exe
  const fallback = resolveWindowsPowerShell('win32', {}, () => {
    throw new Error('not found');
  });
  assert.equal(fallback, 'powershell.exe');
});

test('local CLI resolver resolves Windows .cmd batch scripts from PATH', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cuppet-win-bin-'));
  const cmdFile = join(root, 'opencode.CMD');
  try {
    await writeFile(cmdFile, '@echo off\r\necho 1.0.0\r\n');
    await writeFile(join(root, 'opencode'), '#!/bin/sh\necho 1.0.0\n');
    const environment = {
      PATH: root,
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
    };
    const resolved = resolveLocalCliExecutable('opencode', environment, {
      platform: 'win32',
      environment,
    });
    assert.equal(resolved.toLowerCase(), cmdFile.toLowerCase());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Windows local CLI environment handles camelCase AppData and Roaming npm fallback', () => {
  const env = {
    Path: 'C:\\custom\\bin',
    AppData: 'C:\\Users\\test\\AppData\\Roaming',
  };
  const result = localCliEnvironment(env, { platform: 'win32', home: 'C:\\Users\\test' });
  const entries = result.PATH.split(';');
  assert.ok(entries.includes('C:\\Users\\test\\AppData\\Roaming\\npm'));
});
