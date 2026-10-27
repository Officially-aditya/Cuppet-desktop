import { access, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { join, win32 as win32Path } from 'node:path';
import { detectLocalProviderApp, getEnv, localCliEnvironment, resolveLocalCliExecutable } from './local-cli-environment.mjs';
import { localCliDescriptor } from './local-cli-descriptors.mjs';
import { AcpProcess } from './providers/transports/acp/acp-process.mjs';
import { AcpRpcChannel } from './providers/transports/acp/acp-rpc.mjs';
import { isProbeTimeout, probeProviderCommand, providerProcessEnvironment } from './providers/cli-command.mjs';
import { providerFailureMetadata } from './providers/provider-failure.mjs';

const verifiedExecutables = new Map();
const VERIFICATION_FRESH_MS = 30_000;

/** Chat requires a verified runtime; detection may retain an executable with a startup error. */
export async function resolveCopilotAcpRuntime(configuration = {}, options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const inherited = options.environment || { ...process.env, ...(configuration.cliEnv ?? {}) };
  const home = options.home || getEnv(inherited, 'HOME', 'USERPROFILE') || homedir();
  const environment = providerProcessEnvironment(localCliEnvironment(inherited, { ...options, platform, home }));
  const explicit = String(configuration.cliCommand || environment.CUPPET_COPILOT_BIN || '').trim();
  const verify = options.verifyImpl || verifyCopilotAcpExecutable;
  const candidates = [];
  const seen = new Set();
  let unverified = null;
  const add = (command, source) => {
    if (command && !seen.has(command)) { seen.add(command); candidates.push({ command, source }); }
  };
  const usable = async () => {
    for (const candidate of candidates.splice(0)) {
      let failure;
      try {
        if (await verify(candidate.command, environment, { throwOnError: true, signal: configuration.signal })) {
          return { ...candidate, args: [...(verifiedExecutables.get(verificationKey(candidate.command, environment))?.args ?? localCliDescriptor('github-copilot').args)] };
        }
      }
      catch (error) { failure = error; }
      if (options.allowUnverified && !unverified) {
        try {
          await access(candidate.command, platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
          const diagnostic = providerFailureMetadata(failure)?.diagnostic;
          unverified = { ...candidate, error: [failure?.message || 'ACP initialization did not succeed.', diagnostic].filter(Boolean).join(' ') };
        } catch {}
      }
    }
    return null;
  };
  if (explicit) {
    add(resolveLocalCliExecutable(explicit, environment, { platform, environment }), 'unknown');
    return await usable() ?? unverified;
  }
  add(resolveLocalCliExecutable('copilot', environment, { platform, environment }), 'unknown');
  for (const command of options.additionalCommands ?? []) add(command, 'unknown');
  const standalone = await usable();
  if (standalone) return standalone;

  const pathJoin = platform === 'win32' ? win32Path.join : join;
  const name = platform === 'win32' ? 'copilot.exe' : 'copilot';
  const packageNames = platform === 'linux'
    ? [`copilot-linux-${arch}`, `copilot-linuxmusl-${arch}`]
    : [`copilot-${platform}-${arch}`];
  const addFile = async (command) => {
    try {
      await access(command, platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
      add(command, 'native');
    } catch {}
  };
  const addPackages = async (root) => {
    for (const directory of [pathJoin(root, 'node_modules'), pathJoin(root, 'dist', 'node_modules')]) {
      for (const packageName of packageNames) {
        await addFile(pathJoin(directory, '@github', packageName, name));
        await addFile(pathJoin(directory, '@github', 'copilot', 'node_modules', '@github', packageName, name));
      }
    }
  };
  const addExtensions = async (root) => {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    // Newest installed extension first; a broken copy must not hide a usable older copy.
    const extensions = entries.filter((entry) => entry.isDirectory() && /^github\.copilot(?:-chat)?-/i.test(entry.name))
      .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
    for (const entry of extensions) await addPackages(pathJoin(root, entry.name));
  };
  const app = detectLocalProviderApp('github-copilot', environment, { platform, home });
  for (const directory of options.appDirectories ?? (app ? [app.path] : [])) {
    const root = platform === 'darwin'
      ? pathJoin(directory, 'Contents', 'Resources', 'app')
      : pathJoin(directory, 'resources', 'app');
    await addFile(pathJoin(root, 'bin', name));
    await addPackages(root);
    await addExtensions(pathJoin(root, 'extensions'));
  }
  const extensionRoots = options.extensionDirectories ?? [
    getEnv(environment, 'VSCODE_EXTENSIONS'),
    pathJoin(home, '.vscode', 'extensions'),
    pathJoin(home, '.vscode-insiders', 'extensions'),
  ];
  for (const root of new Set(extensionRoots.filter(Boolean))) await addExtensions(root);
  return await usable() ?? unverified;
}

/** Read-only handshake: do not authenticate or create a provider session during detection. */
export async function verifyCopilotAcpExecutable(command, environment, { timeoutMs = 20_000, throwOnError = false, probeImpl = probeProviderCommand, signal } = {}) {
  const descriptor = localCliDescriptor('github-copilot');
  environment = providerProcessEnvironment(environment);
  const identity = await stat(command).catch(() => null);
  const key = verificationKey(command, environment);
  const signature = identity ? [identity.dev, identity.ino, identity.size, identity.mtimeMs, identity.ctimeMs].join(':') : null;
  const cached = verifiedExecutables.get(key);
  if (signature && cached?.signature === signature && Date.now() - cached.checkedAt < VERIFICATION_FRESH_MS) return true;
  verifiedExecutables.delete(key);
  let rpc;
  const cancel = () => { void rpc?.close().catch(() => undefined); };
  try {
    const help = await probeImpl(command, ['--help'], { env: environment, signal });
    const args = copilotAcpArguments(`${help.stdout ?? ''}\n${help.stderr ?? ''}`);
    let initialized;
    for (const budget of [timeoutMs, timeoutMs * 2]) {
      if (signal?.aborted) throw new Error('Provider setup was cancelled.');
      const processHandle = new AcpProcess({ command, args, env: environment, label: descriptor.label });
      rpc = new AcpRpcChannel({ processHandle, label: descriptor.label });
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        await rpc.ready();
        initialized = await rpc.request('initialize', {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: 'Cuppet Desktop', version: '0.9.0' },
        }, budget);
        break;
      } catch (error) {
        if (signal?.aborted || budget !== timeoutMs || !isProbeTimeout(error)) throw error;
        await rpc.close();
      }
    }
    const verified = initialized?.protocolVersion === 1
      && initialized.agentCapabilities !== null
      && typeof initialized.agentCapabilities === 'object'
      && !Array.isArray(initialized.agentCapabilities);
    if (verified) verifiedExecutables.set(key, { signature, args, checkedAt: Date.now() });
    if (!verified && throwOnError) throw new Error('GitHub Copilot returned an incompatible ACP initialization response.');
    return verified;
  } catch (error) {
    if (throwOnError) throw error;
    return false;
  } finally {
    signal?.removeEventListener('abort', cancel);
    await rpc?.close().catch(() => undefined);
  }
}

export function copilotAcpArguments(help) {
  const args = localCliDescriptor('github-copilot').args;
  if (/--sync-session\b/.test(help)) return [...args, '--sync-session=off'];
  if (/--no-remote-export\b/.test(help)) return [...args, '--no-remote', '--no-remote-export'];
  throw new Error('This Copilot CLI does not advertise a supported way to disable session syncing. Update Copilot and reconnect.');
}

function verificationKey(command, environment) {
  return createHash('sha256').update(JSON.stringify([command, environment])).digest('hex');
}
