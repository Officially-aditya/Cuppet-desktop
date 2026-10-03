import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localProviderOperations } from '../src/runtime/providers/local-provider-operations.mjs';
import { readExecutableVersion } from '../src/runtime/providers/local-provider-version-check.mjs';
import { probeOpenCodeAuthentication } from '../src/runtime/providers/opencode-auth.mjs';
import { AcpSessionRuntime } from '../src/runtime/providers/transports/acp/acp-session.mjs';
import { localCliDescriptor } from '../src/runtime/local-cli-descriptors.mjs';
import { ProviderControlPlane } from '../src/runtime/providers/control-plane.mjs';

test('Windows OpenCode setup and ACP support npm shims and native paths with spaces', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cuppet-windows-cli-'));
  const bin = join(root, 'Custom npm prefix with spaces');
  await mkdir(bin);
  const command = join(bin, 'opencode.cmd');
  const fixture = fileURLToPath(new URL('./fixtures/fake-opencode-acp-agent.mjs', import.meta.url));
  await writeFile(command, `@echo off\r\nif "%~1"=="--version" (\r\n echo OpenCode 1.18.30\r\n exit /b 0\r\n)\r\nif "%~1"=="auth" (\r\n echo 1 credential\r\n exit /b 0\r\n)\r\n"${process.execPath}" "${fixture}" %*\r\n`);
  await writeFile(join(bin, 'opencode'), '#!/bin/sh\nexit 1\n');
  const previous = { path: process.env.PATH, prefix: process.env.NPM_CONFIG_PREFIX, override: process.env.CUPPET_OPENCODE_BIN };
  t.after(async () => {
    process.env.PATH = previous.path;
    process.env.Path = previous.path;
    for (const [name, value] of [['NPM_CONFIG_PREFIX', previous.prefix], ['CUPPET_OPENCODE_BIN', previous.override]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  delete process.env.CUPPET_OPENCODE_BIN;
  process.env.NPM_CONFIG_PREFIX = bin;

  await t.test('existing custom npm prefix is discovered without reinstalling', async () => {
    const operations = localProviderOperations('opencode', { userData: join(root, 'state') });
    const detected = await operations.detect();
    assert.equal(detected.installed, true);
    assert.equal(detected.installation.executable.toLowerCase(), (await realpath(command)).toLowerCase());
    assert.equal(detected.installation.ownedByCuppet, false);
    const connected = await operations.connect();
    assert.equal(connected.available, true);
  });
  await t.test('version and auth checks run the batch launcher', async () => {
    const version = await readExecutableVersion(command);
    assert.match(version.stdout, /1\.18\.30/);
    assert.equal((await probeOpenCodeAuthentication(command)).connected, true);
  });
  await t.test('ACP starts the npm batch launcher instead of its POSIX sibling', async () => {
    const runtime = new AcpSessionRuntime({ descriptor: localCliDescriptor('opencode') });
    try {
      await runtime.start();
      assert.equal(runtime.snapshot().state, 'ready');
    } finally { await runtime.close(); }
  });
  await t.test('native executables and ACP script arguments retain spaces', async () => {
    const native = join(bin, 'OpenCode native.exe');
    const script = join(bin, 'ACP agent.mjs');
    await copyFile(process.execPath, native);
    await copyFile(fixture, script);
    const runtime = new AcpSessionRuntime({ descriptor: localCliDescriptor('opencode'), configuration: { cliCommand: native, cliArgs: [script] } });
    try {
      await runtime.start();
      assert.equal(runtime.snapshot().state, 'ready');
    } finally { await runtime.close(); }
  });
});

test('Windows installer verifies a new CLI and repairs managed versions without changing external installs', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cuppet-windows-install-'));
  const bin = join(root, 'Custom OpenCode prefix');
  const manager = join(root, 'Package manager with spaces');
  await mkdir(bin);
  await mkdir(manager);
  const command = join(bin, 'opencode.cmd');
  const prepared = join(root, 'prepared-opencode.cmd');
  const log = join(root, 'npm calls.txt');
  const launcher = version => `@echo off\r\nif "%~1"=="--version" (\r\n echo OpenCode ${version}\r\n exit /b 0\r\n)\r\necho 1 credential\r\n`;
  await writeFile(prepared, launcher('1.18.30'));
  await writeFile(join(manager, 'npm.cmd'), `@echo off\r\nif "%~1"=="prefix" (\r\n echo %NPM_CONFIG_PREFIX%\r\n exit /b 0\r\n)\r\nif "%~1"=="install" (\r\n copy /y "${prepared}" "%NPM_CONFIG_PREFIX%\\opencode.cmd" >nul\r\n if errorlevel 1 exit /b 1\r\n echo install>>"${log}"\r\n exit /b 0\r\n)\r\nexit /b 1\r\n`);
  const previous = { path: process.env.PATH, prefix: process.env.NPM_CONFIG_PREFIX, override: process.env.CUPPET_OPENCODE_BIN };
  process.env.PATH = process.env.Path = `${manager};${previous.path}`;
  process.env.NPM_CONFIG_PREFIX = bin;
  delete process.env.CUPPET_OPENCODE_BIN;
  t.after(async () => {
    process.env.PATH = process.env.Path = previous.path;
    for (const [name, value] of [['NPM_CONFIG_PREFIX', previous.prefix], ['CUPPET_OPENCODE_BIN', previous.override]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const operations = localProviderOperations('opencode', { userData: join(root, 'state') });
  const plane = new ProviderControlPlane({ dataDir: root, operationsFactory: () => operations });
  await t.test('missing OpenCode is installed and the exact resulting launcher is verified', async () => {
    assert.equal((await operations.detect()).installed, false);
    const status = await plane.localConnect('opencode');
    assert.equal(status.control.overall, 'ready');
    assert.equal(status.installation.ownedByCuppet, true);
    assert.equal(status.installation.executable.toLowerCase(), (await realpath(command)).toLowerCase());
  });
  await t.test('an old managed OpenCode installation is actually upgraded', async () => {
    await writeFile(command, launcher('1.18.29'));
    const status = await plane.localConnect('opencode');
    assert.equal(status.control.overall, 'ready');
    assert.equal(status.control.installation.compatibility.observedVersion, '1.18.30');
    assert.equal((await readFile(log, 'utf8')).trim().split(/\r?\n/).length, 2);
  });
  await t.test('old external and unreadable versions are reported before authentication', async () => {
    const external = new ProviderControlPlane({ dataDir: join(root, 'external'), operationsFactory: () => localProviderOperations('opencode', { userData: join(root, 'external-state') }) });
    await writeFile(command, launcher('1.18.29'));
    await assert.rejects(() => external.localConnect('opencode'), { code: 'PROVIDER_VERSION_UNSUPPORTED' });
    await writeFile(command, launcher('development build'));
    const status = await external.localStatus('opencode');
    assert.equal(status.control.installation.compatibility.state, 'unverified');
    assert.equal(status.control.authentication.state, 'blocked');
    assert.equal((await readFile(log, 'utf8')).trim().split(/\r?\n/).length, 2);
  });
});
