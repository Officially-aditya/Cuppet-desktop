import { redactCredentials } from '../credential-sanitization.mjs';
import { access, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, posix as posixPath, win32 as win32Path } from 'node:path';
import { localCliDescriptor } from '../local-cli-descriptors.mjs';
import { applyLocalCliEnvironment, detectLocalProviderApp, resolveLocalCliExecutable } from '../local-cli-environment.mjs';
import { isProbeTimeout, probeProviderCommand, runProviderCommand, providerProcessEnvironment } from './cli-command.mjs';
import { resolveCopilotAcpRuntime } from '../copilot-acp-runtime.mjs';
import { normalizeProviderInstallation } from './operations.mjs';
import { probeOpenCodeAuthentication } from './opencode-auth.mjs';
import { localProviderVersionLabel } from './version-policy.mjs';
import { antigravityReleaseAsset, resolveAntigravityAcpInstallation } from './backends/antigravity-install.mjs';
import { antigravityAcpDescriptor } from './backends/antigravity.mjs';
import { AcpSessionRuntime, isAcpAuthenticationRequired } from './transports/acp/acp-session.mjs';
import { providerFailureMetadata } from './provider-failure.mjs';

const RUN_TIMEOUT_MS = 5 * 60_000;
const STATUS_TIMEOUT_MS = 8_000;
const LINK_STATE_FILE = 'cli-agent-links.json';
const INSTALLED_CLI_MARKER = '__CUPPET_INSTALLED_CLI__=';

const WINDOWS_CLAUDE_INSTALL = String.raw`
$ErrorActionPreference='Stop'
$npm = (Get-Command npm.cmd -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
& $npm install -g @agentclientprotocol/claude-agent-acp --include=optional
if ($LASTEXITCODE -ne 0) { & $npm install -g @agentclientprotocol/claude-agent-acp --force --include=optional }
if ($LASTEXITCODE -ne 0) { throw 'Claude Code ACP npm installation failed.' }
$prefix = (& $npm prefix -g | Select-Object -Last 1).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the Claude Code ACP installation directory.' }
$cli = Join-Path $prefix 'claude-agent-acp.cmd'
if (-not (Test-Path -LiteralPath $cli)) { throw 'Claude Code ACP installer did not produce a CLI launcher.' }
Write-Output "__CUPPET_INSTALLED_CLI__=$cli"
`;

const WINDOWS_COPILOT_INSTALL = String.raw`
$ErrorActionPreference='Stop'
$npm = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($npm) {
  & $npm.Source install -g @github/copilot --ignore-scripts=false
  if ($LASTEXITCODE -ne 0) { throw 'GitHub Copilot npm installation failed.' }
  $prefix = (& $npm.Source prefix -g | Select-Object -Last 1).Trim()
  if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the Copilot installation directory.' }
  $cli = Join-Path $prefix 'copilot.cmd'
  if (-not (Test-Path -LiteralPath $cli)) { throw 'Copilot installer did not produce a CLI launcher.' }
  Write-Output "__CUPPET_INSTALLED_CLI__=$cli"
} else {
  winget install --id GitHub.Copilot -e --silent --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { throw 'GitHub Copilot WinGet installation failed. Install Node.js 22+ or fix WinGet, then retry.' }
}
`;

const WINDOWS_OPENCODE_INSTALL = String.raw`
$ErrorActionPreference='Stop'
$cli = $null
$npm = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($npm) {
  & $npm.Source install -g opencode-ai
  if ($LASTEXITCODE -ne 0) { & $npm.Source install -g opencode-ai --force }
  if ($LASTEXITCODE -ne 0) { throw 'OpenCode npm installation failed.' }
  $prefix = (& $npm.Source prefix -g | Select-Object -Last 1).Trim()
  if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the OpenCode npm installation directory.' }
  $cli = Join-Path $prefix 'opencode.cmd'
} elseif (Get-Command choco -ErrorAction SilentlyContinue) {
  choco upgrade opencode -y
  if ($LASTEXITCODE -ne 0) { throw 'OpenCode Chocolatey installation failed.' }
} elseif (Get-Command scoop -ErrorAction SilentlyContinue) {
  $existing = Get-Command opencode -ErrorAction SilentlyContinue
  if ($existing) { scoop update opencode } else { scoop install opencode }
  if ($LASTEXITCODE -ne 0) { throw 'OpenCode Scoop installation failed.' }
} else { throw 'OpenCode automatic install needs npm, Chocolatey, or Scoop on Windows.' }
if (-not $cli) { $cli = (Get-Command opencode -CommandType Application -ErrorAction Stop).Source }
if (-not (Test-Path -LiteralPath $cli)) { throw 'OpenCode installer did not produce a CLI launcher.' }
& $cli --version
if ($LASTEXITCODE -ne 0) { throw 'OpenCode was installed but its CLI could not start.' }
Write-Output "__CUPPET_INSTALLED_CLI__=$cli"
`;

// Finder-launched macOS apps do not inherit the user's interactive shell PATH.
extendCliSearchPath();

/**
 * Runtime-owned local CLI lifecycle operations.
 *
 * Detection/probing are read-only. Installation/update/authentication are explicit
 * mutations. Cuppet update authority is bound to the executable identity it actually
 * installed, not merely to a historical "installedByCuppet" marker.
 */
export function localProviderOperations(providerID, {
  userData,
  runImpl = runProviderCommand,
  platform = process.platform,
  now = () => Date.now(),
  executableIdentityImpl = executableIdentity,
  resolveAntigravityInstallationImpl = resolveAntigravityAcpInstallation,
  antigravityInstallOptions = {},
  resolveCopilotRuntimeImpl = resolveCopilotAcpRuntime,
  copilotRuntimeOptions = {},
  onAuthenticationUrl,
  onAuthenticationOutput,
  onAuthenticationBrowserRequest,
  runAuthTerminal,
  signal,
  acpRuntimeFactory = (options) => new AcpSessionRuntime(options),
} = {}) {
  const execute = runImpl;
  runImpl = (command, args, timeoutMs, options = {}) => execute(command, args, timeoutMs, { ...options, ...(signal ? { signal } : {}) });
  const descriptor = localCliDescriptor(providerID);
  if (!descriptor) throw new Error('Unsupported local CLI provider.');

  const command = () => {
    extendCliSearchPath();
    return String(process.env[descriptor.envOverride] || descriptor.command);
  };

  const detect = async ({ refresh = false } = {}) => {
    applyLocalCliEnvironment({ refresh });
    const officialApp = detectLocalProviderApp(descriptor.id, process.env, { platform });
    if (descriptor.id === 'antigravity') {
      let runtimeInstallation;
      let error = null;
      try {
        runtimeInstallation = await resolveAntigravityInstallationImpl({}, { ...antigravityInstallOptions, platform, allowInstall: false });
      } catch (failure) { error = cleanError(failure); }
      const identity = runtimeInstallation ? await executableIdentityImpl(runtimeInstallation.command).catch(() => null) : null;
      return {
        providerID: descriptor.id, label: descriptor.label,
        installed: Boolean(runtimeInstallation), version: runtimeInstallation?.version ?? null,
        officialApp, error,
        installation: normalizeProviderInstallation({
          detected: Boolean(runtimeInstallation), executable: runtimeInstallation?.command,
          version: runtimeInstallation?.version, source: runtimeInstallation?.source,
          ownedByCuppet: runtimeInstallation?.source === 'managed', canUpdate: false, identity,
        }),
      };
    }
    if (descriptor.id === 'github-copilot') {
      const state = await providerState(userData, descriptor.id);
      const recordedIdentity = normalizeStoredIdentity(state.executableIdentity);
      let runtimeInstallation = await resolveCopilotRuntimeImpl({ signal }, {
        ...copilotRuntimeOptions, platform, allowUnverified: true,
        additionalCommands: state.installedByCuppet && recordedIdentity?.resolvedPath ? [recordedIdentity.resolvedPath] : [],
      });
      if (!runtimeInstallation && platform === 'win32' && !process.env[descriptor.envOverride]) {
        const npmExecutable = await findNpmExecutable(descriptor, runImpl);
        if (npmExecutable) {
          runtimeInstallation = await resolveCopilotRuntimeImpl({ cliCommand: npmExecutable }, { ...copilotRuntimeOptions, platform, allowUnverified: true });
          if (runtimeInstallation) extendCliSearchPath([dirname(npmExecutable)]);
        }
      }
      const executable = runtimeInstallation?.command;
      if (executable && executable === recordedIdentity?.resolvedPath) extendCliSearchPath([dirname(executable)]);
      const identity = executable ? await executableIdentityImpl(executable).catch(() => null) : null;
      const ownershipMatches = Boolean(runtimeInstallation) && state.installedByCuppet === true && executableIdentityMatches(recordedIdentity, identity);
      let error = runtimeInstallation?.error ? cleanError(runtimeInstallation.error) : null;
      const result = executable
        ? await probeProviderCommand(executable, descriptor.versionArgs, { runImpl }).catch((failure) => {
          error ||= cleanError(failure);
          return null;
        })
        : null;
      const version = result ? localProviderVersionLabel(descriptor.id, result) : null;
      return {
        providerID: descriptor.id, label: descriptor.label, officialApp,
        installed: Boolean(runtimeInstallation), version, error,
        installation: normalizeProviderInstallation({
          detected: Boolean(runtimeInstallation), executable, version,
          source: ownershipMatches ? state.installSource : runtimeInstallation?.source,
          ownedByCuppet: ownershipMatches,
          canUpdate: ownershipMatches && Boolean(updateSpec(descriptor.id, platform, state.installSource)),
          identity,
        }),
      };
    }
    const rawCommand = command();
    const state = await providerState(userData, descriptor.id);
    let resolved = await resolveExecutablePath(rawCommand);
    const recordedIdentity = normalizeStoredIdentity(state.executableIdentity);
    if (!resolved && !process.env[descriptor.envOverride] && state.installedByCuppet && recordedIdentity?.resolvedPath && await executableAt(recordedIdentity.resolvedPath)) {
      resolved = recordedIdentity.resolvedPath;
      extendCliSearchPath([dirname(resolved)]);
    }
    let executable = resolved || rawCommand;
    let result;
    let probeError;
    try {
      result = await probeProviderCommand(executable, descriptor.versionArgs, { runImpl });
    } catch (error) { probeError = error; }
    if (probeError && !resolved && platform === 'win32' && !process.env[descriptor.envOverride]) {
      const npmExecutable = await findNpmExecutable(descriptor, runImpl);
      if (npmExecutable) {
        resolved = executable = npmExecutable;
        extendCliSearchPath([dirname(executable)]);
        try {
          result = await probeProviderCommand(executable, descriptor.versionArgs, { runImpl });
          probeError = null;
        } catch (error) { probeError = error; }
      }
    }
    const installed = Boolean(result || resolved);
    const version = result ? localProviderVersionLabel(descriptor.id, result) : null;
    if (!installed) {
      const errorMsg = String(probeError?.message ?? probeError ?? '');
      const missing = probeError?.code === 'ENOENT' || /not found|ENOENT|command not found|is not recognized as an internal or external command/i.test(errorMsg);
      return {
        providerID: descriptor.id,
        label: descriptor.label,
        officialApp,
        installed: false,
        ...(descriptor.id === 'claude-code' ? { missingAdapter: descriptor.command } : {}),
        installation: normalizeProviderInstallation({ detected: false, executable, source: state.installSource }),
        error: missing ? null : cleanError(probeError),
      };
    }

    const identity = await executableIdentityImpl(executable).catch(() => null);
    const ownershipMatches = state.installedByCuppet === true && executableIdentityMatches(recordedIdentity, identity);
    const spec = installSpec(descriptor.id, platform);
    const resolvedExecutable = identity?.realPath || identity?.resolvedPath || executable;
    return {
      providerID: descriptor.id,
      label: descriptor.label,
      officialApp,
      installed: true,
      version,
      ...(probeError ? { error: cleanError(probeError) } : {}),
      installation: normalizeProviderInstallation({
        detected: true,
        executable: resolvedExecutable,
        version,
        source: ownershipMatches ? state.installSource : 'unknown',
        ownedByCuppet: ownershipMatches,
        canUpdate: ownershipMatches && Boolean(updateSpec(descriptor.id, platform, state.installSource || spec?.source)),
        identity,
      }),
    };
  };

  const makeRuntime = async (detected, { interactive = false, startupMs = STATUS_TIMEOUT_MS } = {}) => {
    let runtimeDescriptor = descriptor;
    if (descriptor.id === 'antigravity') {
      const installation = await resolveAntigravityInstallationImpl({}, { ...antigravityInstallOptions, platform, allowInstall: false });
      if (!installation) throw new Error('Antigravity ACP must be installed before authentication.');
      runtimeDescriptor = antigravityAcpDescriptor(installation);
    }
    return acpRuntimeFactory({
      descriptor: runtimeDescriptor,
      configuration: {
        ...(descriptor.id !== 'antigravity' ? { cliCommand: detected.installation.executable } : {}),
        signal,
        ...(interactive ? { allowInteractiveAuth: true, runAuthTerminal, onAuthenticationOutput, onAuthenticationBrowserRequest, onAuthenticationUrl } : {}),
      },
      liveness: { startupMs, authenticationMs: interactive ? RUN_TIMEOUT_MS : 30_000 },
    });
  };

  const verifyConnection = async (detected) => {
    for (const startupMs of [STATUS_TIMEOUT_MS, 30_000]) {
      const runtime = await makeRuntime(detected, { startupMs });
      try { await runtime.start(); return; }
      catch (error) {
        if (signal?.aborted || startupMs === 30_000 || !isProbeTimeout(error)) throw error;
      } finally { await runtime.close(); }
    }
  };

  const probe = async (detected = null) => {
    detected ??= await detect();
    if (!detected.installed) return { ...detected, connected: false, available: false, probe: 'not-installed' };
    if (detected.error) return { ...detected, connected: false, available: false, probe: 'startup-failed' };
    let providerReady = false;
    let probeError = null;
    let authentication = null;
    let needsAuthentication = false;
    try {
      if (descriptor.id === 'opencode') {
        authentication = await probeOpenCodeAuthentication(detected.installation.executable, { runImpl, version: detected.version, signal });
        providerReady = authentication.connected === true;
      } else if (['claude-code', 'kiro'].includes(descriptor.id)) {
        providerReady = await probeConnection(descriptor, detected.installation.executable, runImpl);
      } else {
        await verifyConnection(detected);
        providerReady = true;
      }
    } catch (error) {
      probeError = cleanError(error);
      needsAuthentication = isAcpAuthenticationRequired(error) || providerFailureMetadata(error)?.category === 'authentication';
    }
    return {
      ...detected,
      connected: providerReady,
      available: providerReady,
      probe: providerReady ? 'provider' : needsAuthentication || !probeError ? 'not-authenticated' : 'probe-failed',
      ...(authentication ? { authentication } : {}),
      ...(probeError ? { probeError, ...(!needsAuthentication ? { error: probeError } : {}) } : {}),
    };
  };

  const install = async () => {
    const before = await detect();
    if (before.installed) return before;
    if (descriptor.id === 'antigravity') {
      if (before.error) throw new Error(before.error);
      await resolveAntigravityInstallationImpl({}, { ...antigravityInstallOptions, platform, signal });
      const detected = await detect();
      if (!detected.installed || detected.error) throw new Error(detected.error || 'Antigravity ACP installation could not be verified.');
      return detected;
    }
    const spec = installSpec(descriptor.id, platform);
    if (!spec) throw new Error(`Automatic ${descriptor.label} installation is not available on this platform yet.`);
    if (descriptor.id === 'claude-code') await preflightClaudeInstall(runImpl, platform);
    const installed = await runImpl(spec.command, spec.args, RUN_TIMEOUT_MS, { stdin: 'ignore', env: spec.env });
    await applyInstallerExecutable(installed);
    extendCliSearchPath();
    const detected = await detect({ refresh: true });
    if (!detected.installed || detected.error) throw new Error(`${descriptor.label} installation could not be verified.${detected.error ? ` ${detected.error}` : ' The installer did not produce a usable CLI.'}`);
    await markInstalled(userData, descriptor.id, {
      source: spec.source,
      installedAt: now(),
      executableIdentity: detected.installation.identity,
    });
    return detect();
  };

  const update = async () => {
    const detected = await detect();
    if (!detected.installed) throw new Error(`${descriptor.label} is not installed.`);
    if (descriptor.id === 'antigravity') throw new Error('Antigravity ACP runtime updates are delivered with Cuppet releases.');
    if (!detected.installation.ownedByCuppet || detected.installation.source === 'unknown') {
      throw new Error(`Cuppet does not own this ${descriptor.label} installation, so it will not update it automatically.`);
    }
    const spec = updateSpec(descriptor.id, platform, detected.installation.source);
    if (!spec) throw new Error(`Automatic ${descriptor.label} updates are not available for this installation source.`);
    if (descriptor.id === 'claude-code') await preflightClaudeInstall(runImpl, platform);
    const updated = await runImpl(spec.command, spec.args, RUN_TIMEOUT_MS, { stdin: 'ignore', env: spec.env });
    await applyInstallerExecutable(updated);
    extendCliSearchPath();
    const after = await detect({ refresh: true });
    if (!after.installed || after.error) throw new Error(`${descriptor.label} update could not be verified.${after.error ? ` ${after.error}` : ' The CLI could not be found.'}`);
    await markInstalled(userData, descriptor.id, {
      source: detected.installation.source,
      installedAt: now(),
      updatedAt: now(),
      executableIdentity: after.installation.identity,
    });
    return detect();
  };

  const authenticate = async ({ forceAuthentication = false } = {}) => {
    const detected = await detect();
    if (!detected.installed) throw new Error(`${descriptor.label} must be installed before authentication.`);
    if (detected.error) throw new Error(`${descriptor.label} startup check failed: ${detected.error}`);
    const current = await probe(detected);
    if (current.connected && !forceAuthentication) {
      try { await verifyConnection(detected); return current; }
      catch (error) {
        if (!isAcpAuthenticationRequired(error) && providerFailureMetadata(error)?.category !== 'authentication') throw error;
      }
    }
    let runtime = await makeRuntime(detected, { interactive: true, startupMs: 30_000 });
    try {
      await runtime.start({ initializeOnly: true });
      const methods = runtime.authenticationMethods();
      const preferred = descriptor.authentication?.methods ?? [];
      const preferredMethod = [...preferred].sort((a, b) => Number(b.interactive === true) - Number(a.interactive === true)).flatMap((choice) =>
        choice.requiresEnv && !process.env[choice.requiresEnv] ? [] : methods.filter((method) => method.id === choice.id))[0];
      const method = preferredMethod ?? methods.find((item) => item.type === 'terminal' && runAuthTerminal)
        ?? methods.find((item) => !item.type || item.type === 'agent');
      // Older OpenCode advertises a terminal instruction as an agent method.
      const legacyTerminal = !method || method.id === 'opencode-login';
      if (method?.type === 'terminal' || legacyTerminal) {
        if (typeof runAuthTerminal !== 'function') throw new Error(`Open Settings to complete ${descriptor.label} sign-in in the interactive terminal.`);
        const launch = runtime.authenticationLaunch();
        let login;
        if (method?.type === 'terminal') {
          const args = Array.isArray(method.args) ? method.args : [];
          if (args.length > 64 || args.some((arg) => typeof arg !== 'string' || arg.includes('\0') || arg.length > 4096)) throw new Error('Provider returned invalid terminal authentication arguments.');
          const extraEnv = {};
          for (const [key, value] of Object.entries(method.env ?? {})) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0') || value.length > 32768) throw new Error('Provider returned invalid terminal authentication environment.');
            extraEnv[key] = value;
          }
          login = { command: launch.command, args: [...launch.args, ...args], env: { ...launch.env, ...extraEnv }, cwd: launch.cwd };
        } else {
          login = loginSpec(descriptor.id, detected.installation.executable);
          if (!login) throw new Error(`${descriptor.label} did not advertise a supported sign-in method.`);
          login = { ...login, env: launch.env, cwd: launch.cwd };
        }
        await runtime.close();
        runtime = null;
        await runAuthTerminal(login.command, login.args, { env: providerProcessEnvironment(login.env), cwd: login.cwd });
        await verifyConnection(detected);
      } else {
        await runtime.authenticate(method.id);
        try { await runtime.start(); }
        catch (error) {
          // Some adapters acknowledge browser auth before credentials exist.
          // Their official interactive setup remains available in the same UI.
          const needsAuth = isAcpAuthenticationRequired(error) || providerFailureMetadata(error)?.category === 'authentication';
          const login = needsAuth && !signal?.aborted && runAuthTerminal ? loginSpec(descriptor.id, detected.installation.executable) : null;
          if (!login) throw error;
          const launch = runtime.authenticationLaunch();
          await runtime.close();
          runtime = null;
          await runAuthTerminal(login.command, login.args, { env: providerProcessEnvironment(launch.env), cwd: launch.cwd });
          await verifyConnection(detected);
        }
      }
    } finally { await runtime?.close(); }
    // Recheck persisted credentials in a fresh process. A terminal's exit code or
    // a model catalog alone cannot prove the provider is authenticated.
    const next = await probe(detected);
    if (!next.connected) throw new Error(next.probeError || `${descriptor.label} sign-in has not completed. Finish sign-in and reconnect.`);
    await markLinked(userData, descriptor.id, now());
    return next;
  };

  const status = async (detected = null) => statusProjection(descriptor, await probe(detected), platform);
  const connect = async (options = {}) => {
    const detected = await detect();
    if (!detected.installed) await install();
    await authenticate(options);
    return status();
  };

  return Object.freeze({ detect, probe, install, update, authenticate, status, connect });
}

function statusProjection(descriptor, state, platform) {
  const installed = state.installed === true;
  const connected = state.connected === true;
  const version = state.version ?? null;
  const canAutoInstall = descriptor.id === 'antigravity'
    ? Boolean(antigravityReleaseAsset(platform))
    : Boolean(installSpec(descriptor.id, platform));
  return {
    providerID: descriptor.id,
    label: descriptor.label,
    available: connected,
    installed,
    connected,
    version,
    action: connected ? 'ready' : 'connect',
    canAutoInstall,
    installation: state.installation,
    officialApp: state.officialApp ?? null,
    ...(state.error ? { error: state.error } : {}),
    ...(state.missingAdapter ? { missingAdapter: state.missingAdapter } : {}),
    message: !installed
      ? state.error
        ? `${descriptor.label} could not be started: ${state.error}`
        : state.missingAdapter
          ? `${descriptor.label} needs the ${state.missingAdapter} connection adapter. Cuppet will install the adapter automatically when you connect.`
        : state.officialApp
          ? `${state.officialApp.label} was detected. Cuppet still needs ${descriptor.label === 'GitHub Copilot' ? 'a usable Copilot ACP runtime' : 'the Antigravity connection runtime'} to connect. It will install the missing runtime when you connect.`
          : `${descriptor.label} is not installed yet. Cuppet will install it when you connect.`
      : state.error
        ? `${descriptor.label} is installed, but its ${state.probeError ? 'authentication' : 'startup'} check failed: ${state.error} Reconnect to retry.`
      : connected
        ? `${descriptor.label} is connected and ready to use in Cuppet${version ? ` · ${version}` : ''}.`
        : descriptor.id === 'opencode' && state.probeError
          ? `OpenCode is installed, but its authentication check failed: ${state.probeError} Refresh or reconnect to retry.`
        : descriptor.id === 'opencode' && state.authentication?.connected === false
          ? 'OpenCode is installed, but no authenticated provider credentials were found. Run `opencode auth login` in Terminal, then refresh or reconnect.'
          : `${descriptor.label} is installed. Connect once and Cuppet will open the provider's official sign-in flow.`,
  };
}

export function installSpec(providerID, platform = process.platform) {
  const id = String(providerID ?? '').trim().toLowerCase();
  if (platform === 'darwin' || platform === 'linux') {
    const specs = {
      opencode: { source: 'managed', script: 'curl -fsSL https://opencode.ai/install | bash' },
      'claude-code': { source: 'npm', script: 'npm install -g @agentclientprotocol/claude-agent-acp --include=optional' },
      'grok-build': { source: 'managed', script: 'curl -fsSL https://x.ai/cli/install.sh | bash' },
      'github-copilot': { source: 'managed', script: 'curl -fsSL https://gh.io/copilot-install | PREFIX="$HOME/.local" bash' },
      'mistral-vibe': { source: 'managed', script: 'curl -LsSf https://mistral.ai/vibe/install.sh | bash' },
      kiro: { source: 'managed', script: 'curl -fsSL https://cli.kiro.dev/install | bash' },
      antigravity: { source: 'managed', script: 'curl -fsSL https://antigravity.google/cli/install.sh | bash' },
    };
    const spec = specs[id];
    return spec ? { command: '/bin/bash', args: ['-lc', spec.script], source: spec.source } : null;
  }
  if (platform === 'win32') {
    const specs = {
      'claude-code': { source: 'npm', script: WINDOWS_CLAUDE_INSTALL },
      'grok-build': { source: 'managed', script: 'irm https://x.ai/cli/install.ps1 | iex' },
      'github-copilot': { source: 'managed', script: WINDOWS_COPILOT_INSTALL },
      'mistral-vibe': { source: 'managed', script: "$ErrorActionPreference='Stop'; if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { irm https://astral.sh/uv/install.ps1 | iex }; $uv=(Get-Command uv -ErrorAction SilentlyContinue).Source; if (-not $uv) { $uv=Join-Path $env:USERPROFILE '.local\\bin\\uv.exe' }; & $uv tool install mistral-vibe" },
      kiro: { source: 'managed', script: "irm 'https://cli.kiro.dev/install.ps1' | iex" },
      antigravity: { source: 'managed', script: 'irm https://antigravity.google/cli/install.ps1 | iex' },
      opencode: { source: 'managed', script: WINDOWS_OPENCODE_INSTALL },
    };
    const spec = specs[id];
    const powerShellCmd = 'powershell.exe';
    const script = spec ? `$ErrorActionPreference='Stop'; $global:LASTEXITCODE=0; try {\n${spec.script}\nif ($LASTEXITCODE -ne 0) { throw 'Provider installer failed.' }\n} catch { Write-Error $_ -ErrorAction Continue; exit 1 }` : '';
    return spec ? { command: powerShellCmd, args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], source: spec.source } : null;
  }
  return null;
}

export function updateSpec(providerID, platform = process.platform, source = '') {
  const install = installSpec(providerID, platform);
  if (!install) return null;
  const normalizedSource = String(source || install.source || '').toLowerCase();
  if (!normalizedSource || normalizedSource === 'unknown' || normalizedSource !== install.source) return null;
  // Official installers and package-manager install commands are expected to be
  // idempotent upgrades. This path is reachable only for Cuppet-owned installs.
  return install;
}

export function loginSpec(providerID, commandOverride = '') {
  const id = String(providerID ?? '').trim().toLowerCase();
  const descriptor = localCliDescriptor(id);
  if (!descriptor) return null;
  const command = commandOverride || descriptor.command;
  switch (id) {
    case 'opencode': return { command, args: ['auth', 'login'] };
    case 'claude-code': return { command, args: ['--cli', 'auth', 'login'] };
    case 'grok-build': return { command, args: ['login'] };
    case 'github-copilot': return { command, args: ['login', '--web-flow'] };
    case 'kiro': return { command, args: ['login'] };
    case 'mistral-vibe': return { command: siblingCommand(command, 'vibe'), args: ['--setup'] };
    case 'antigravity': return null;
    default: return null;
  }
}

async function probeConnection(descriptor, command, runImpl) {
  if (descriptor.id === 'claude-code') {
    await probeProviderCommand(command, ['--cli', 'auth', 'status', '--json'], { runImpl, discardOutput: true });
    return true;
  }
  if (descriptor.id === 'kiro') {
    await probeProviderCommand(command, ['whoami', '--format', 'json'], { runImpl });
    return true;
  }
  return false;
}

async function providerState(userData, providerID) {
  if (!userData) return {};
  try {
    const parsed = JSON.parse(await readFile(join(userData, LINK_STATE_FILE), 'utf8'));
    const state = parsed?.providers?.[providerID];
    return state && typeof state === 'object' ? state : {};
  } catch { return {}; }
}

async function markLinked(userData, providerID, linkedAt) {
  if (!userData) return;
  await patchProviderState(userData, providerID, { linkedAt });
}
async function markInstalled(userData, providerID, patch) {
  if (!userData) return;
  await patchProviderState(userData, providerID, {
    installedByCuppet: true,
    installSource: patch.source || 'managed',
    installedAt: patch.installedAt,
    executableIdentity: patch.executableIdentity ?? null,
    ...(patch.updatedAt ? { updatedAt: patch.updatedAt } : {}),
  });
}
async function patchProviderState(userData, providerID, patch) {
  const path = join(userData, LINK_STATE_FILE);
  let parsed = { version: 3, providers: {} };
  try {
    const current = JSON.parse(await readFile(path, 'utf8'));
    if (current && typeof current === 'object') parsed = { version: 3, providers: { ...(current.providers ?? {}) } };
  } catch {}
  parsed.providers[providerID] = { ...(parsed.providers[providerID] ?? {}), ...patch };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
}

function extendCliSearchPath(additional = []) {
  const home = homedir();
  const existing = String(process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean);
  const npmPrefix = process.env.NPM_CONFIG_PREFIX || process.env.npm_config_prefix;
  const npmPrefixPath = npmPrefix ? (process.platform === 'win32' ? npmPrefix : join(npmPrefix, 'bin')) : '';
  const candidates = [
    process.env.CUPPET_CLI_PATH,
    npmPrefixPath,
    process.env.PNPM_HOME,
    process.env.GROK_BIN_DIR,
    process.env.BUN_INSTALL ? join(process.env.BUN_INSTALL, 'bin') : '',
    npmPrefixPath ? '' : (process.env.APPDATA ? (process.platform === 'win32' ? win32Path.join(process.env.APPDATA, 'npm') : join(process.env.APPDATA, 'npm')) : (process.platform === 'win32' && home ? win32Path.join(home, 'AppData', 'Roaming', 'npm') : '')),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'agy', 'bin') : '',
    home ? join(home, '.local', 'bin') : '',
    home ? join(home, '.opencode', 'bin') : '',
    home ? join(home, '.grok', 'bin') : '',
    home ? join(home, '.kiro', 'bin') : '',
    home ? join(home, '.vibe', 'bin') : '',
    home ? join(home, '.copilot', 'bin') : '',
    home ? join(home, '.bun', 'bin') : '',
    home ? join(home, '.npm-global', 'bin') : '',
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env.LOCALAPPDATA || (home ? win32Path.join(home, 'AppData', 'Local') : '');
    candidates.push(
      win32Path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
      win32Path.join(systemRoot, 'System32'),
      systemRoot,
      win32Path.join(systemRoot, 'System32', 'OpenSSH'),
      win32Path.join(programFiles, 'PowerShell', '7'),
      win32Path.join(programFiles, 'Git', 'cmd'),
      win32Path.join(programFiles, 'Git', 'bin'),
      localAppData ? win32Path.join(localAppData, 'Programs', 'Git', 'cmd') : '',
      localAppData ? win32Path.join(localAppData, 'Programs', 'Git', 'bin') : '',
      localAppData ? win32Path.join(localAppData, 'Microsoft', 'WinGet', 'Links') : '',
      win32Path.join(programFiles, 'WinGet', 'Links'),
      localAppData ? win32Path.join(localAppData, 'Microsoft', 'WindowsApps') : '',
      win32Path.join(programFiles, 'Kiro-Cli'),
      home ? win32Path.join(home, 'scoop', 'shims') : '',
      win32Path.join(programFiles, 'nodejs'),
      win32Path.join(programFilesX86, 'nodejs'),
    );
  }
  const seen = new Set();
  const nextPath = [...additional, ...existing, ...candidates.filter(Boolean)].filter((entry) => {
    if (seen.has(entry)) return false;
    seen.add(entry);
    return true;
  }).join(delimiter);
  process.env.PATH = nextPath;
  if (process.platform === 'win32') process.env.Path = nextPath;
}

async function executableIdentity(command) {
  const resolvedPath = await resolveExecutablePath(command);
  if (!resolvedPath) return null;
  const realPath = await realpath(resolvedPath).catch(() => resolvedPath);
  const metadata = await stat(realPath).catch(() => null);
  if (!metadata?.isFile()) return null;
  return {
    resolvedPath,
    realPath,
    ...(Number.isFinite(Number(metadata.dev)) ? { dev: Number(metadata.dev) } : {}),
    ...(Number.isFinite(Number(metadata.ino)) ? { ino: Number(metadata.ino) } : {}),
    size: Number(metadata.size),
    mtimeMs: Math.trunc(Number(metadata.mtimeMs)),
  };
}

async function resolveExecutablePath(command) {
  const resolved = resolveLocalCliExecutable(command);
  return resolved && await executableAt(resolved) ? resolved : null;
}

async function findNpmExecutable(descriptor, runImpl) {
  try {
    const prefixOverride = process.env.NPM_CONFIG_PREFIX || process.env.npm_config_prefix;
    let prefix = prefixOverride && win32Path.isAbsolute(prefixOverride) ? prefixOverride : null;
    if (!prefix) {
      const result = await runImpl('npm.cmd', ['prefix', '-g'], STATUS_TIMEOUT_MS, { stdin: 'ignore' });
      prefix = String(result.stdout ?? '').trim().split(/\r?\n/).at(-1)?.trim();
    }
    if (!prefix || !win32Path.isAbsolute(prefix)) return null;
    for (const name of [`${descriptor.command}.cmd`, `${descriptor.command}.exe`]) {
      const path = win32Path.join(prefix, name);
      if (await executableAt(path)) return path;
    }
  } catch {}
  return null;
}

async function applyInstallerExecutable(result) {
  const line = String(result?.stdout ?? '').split(/\r?\n/).map((value) => value.trim()).find((value) => value.startsWith(INSTALLED_CLI_MARKER));
  const path = line?.slice(INSTALLED_CLI_MARKER.length);
  if (path && await executableAt(path)) extendCliSearchPath([dirname(path)]);
}

async function executableAt(path) {
  try {
    await access(path, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableIdentityMatches(recorded, current) {
  if (!recorded && !current) return true;
  if (!recorded || !current) return false;
  if (recorded.realPath && current.realPath && recorded.realPath !== current.realPath) return false;
  if (Number.isFinite(recorded.dev) && Number.isFinite(recorded.ino) && Number.isFinite(current.dev) && Number.isFinite(current.ino)) {
    return recorded.dev === current.dev && recorded.ino === current.ino;
  }
  return recorded.resolvedPath === current.resolvedPath && recorded.realPath === current.realPath;
}

function normalizeStoredIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const resolvedPath = typeof value.resolvedPath === 'string' ? value.resolvedPath : '';
  const realPath = typeof value.realPath === 'string' ? value.realPath : '';
  if (!resolvedPath && !realPath) return null;
  return {
    resolvedPath: resolvedPath || realPath,
    realPath: realPath || resolvedPath,
    ...(Number.isFinite(Number(value.dev)) ? { dev: Number(value.dev) } : {}),
    ...(Number.isFinite(Number(value.ino)) ? { ino: Number(value.ino) } : {}),
    ...(Number.isFinite(Number(value.size)) ? { size: Number(value.size) } : {}),
    ...(Number.isFinite(Number(value.mtimeMs)) ? { mtimeMs: Number(value.mtimeMs) } : {}),
  };
}

function siblingCommand(command, sibling) {
  const value = String(command || '');
  if (!value.includes('/') && !value.includes('\\')) return sibling;
  if (value.includes('/') && !value.includes('\\')) {
    return posixPath.join(posixPath.dirname(value), value.toLowerCase().endsWith('.exe') ? `${sibling}.exe` : sibling);
  }
  return join(dirname(value), (process.platform === 'win32' || value.toLowerCase().endsWith('.exe')) ? `${sibling}.exe` : sibling);
}

export async function preflightClaudeInstall(runImpl = runProviderCommand, platform = process.platform, accessImpl = access) {
  let node;
  try { node = await probeProviderCommand('node', ['--version'], { runImpl }); }
  catch { throw new Error('Claude’s connection adapter requires Node.js 22 or newer. Install Node.js, then reconnect; Cuppet will install the adapter automatically.'); }
  const major = Number(String(node.stdout ?? '').trim().match(/^v?(\d+)\./)?.[1]);
  if (!Number.isInteger(major) || major < 22) throw new Error('Claude’s connection adapter requires Node.js 22 or newer. Upgrade Node.js, then reconnect.');
  const npm = platform === 'win32' ? 'npm.cmd' : 'npm';
  let root;
  try {
    await probeProviderCommand(npm, ['--version'], { runImpl });
    const result = await probeProviderCommand(npm, ['root', '-g'], { runImpl });
    root = String(result.stdout ?? '').trim().split(/\r?\n/).at(-1);
  } catch { throw new Error('npm is required to install Claude’s connection adapter. Install npm with Node.js, then reconnect.'); }
  if (!(platform === 'win32' ? win32Path.isAbsolute(root || '') : isAbsolute(root || ''))) throw new Error('npm did not report a usable global installation directory. Check the npm configuration, then reconnect.');
  const parent = platform === 'win32' ? win32Path.dirname : dirname;
  let directory = root;
  while (directory) {
    try { await accessImpl(directory, fsConstants.W_OK); return; }
    catch (error) {
      if (error?.code !== 'ENOENT' || parent(directory) === directory) {
        throw new Error(`The npm installation directory is not writable (${directory}). Configure a user-owned npm prefix, then reconnect.`);
      }
      directory = parent(directory);
    }
  }
}
function cleanError(error) { return redactCredentials(error).slice(0, 500); }
