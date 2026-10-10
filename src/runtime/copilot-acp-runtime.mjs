import { access, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { join, win32 as win32Path } from 'node:path';
import { detectLocalProviderApp, getEnv, localCliEnvironment, resolveLocalCliExecutable } from './local-cli-environment.mjs';
import { localCliDescriptor } from './local-cli-descriptors.mjs';
import { AcpProcess } from './providers/transports/acp/acp-process.mjs';
import { AcpRpcChannel } from './providers/transports/acp/acp-rpc.mjs';

const verifiedExecutables = new Map();
const VERIFICATION_FRESH_MS = 30_000;

/** Resolve only runtimes that answer ACP initialize; app/SDK presence alone is insufficient. */
export async function resolveCopilotAcpRuntime(configuration = {}, options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const inherited = options.environment || { ...process.env, ...(configuration.cliEnv ?? {}) };
  const home = options.home || getEnv(inherited, 'HOME', 'USERPROFILE') || homedir();
  const environment = localCliEnvironment(inherited, { ...options, platform, home });
  const explicit = String(configuration.cliCommand || environment.CUPPET_COPILOT_BIN || '').trim();
  const verify = options.verifyImpl || verifyCopilotAcpExecutable;
  const candidates = [];
  const seen = new Set();
  const add = (command, source) => {
    if (command && !seen.has(command)) { seen.add(command); candidates.push({ command, source }); }
  };
  const usable = async () => {
    for (const candidate of candidates.splice(0)) {
      try { if (await verify(candidate.command, environment)) return candidate; } catch {}
    }
    return null;
  };
  if (explicit) {
    add(resolveLocalCliExecutable(explicit, environment, { platform, environment }), 'unknown');
    return usable();
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
  return usable();
}

/** Read-only handshake: do not authenticate or create a provider session during detection. */
export async function verifyCopilotAcpExecutable(command, environment, { timeoutMs = 8_000 } = {}) {
  const descriptor = localCliDescriptor('github-copilot');
  const identity = await stat(command).catch(() => null);
  const key = createHash('sha256').update(JSON.stringify([command, environment])).digest('hex');
  const signature = identity ? [identity.dev, identity.ino, identity.size, identity.mtimeMs, identity.ctimeMs].join(':') : null;
  const cached = verifiedExecutables.get(key);
  if (signature && cached?.signature === signature && Date.now() - cached.checkedAt < VERIFICATION_FRESH_MS) return true;
  verifiedExecutables.delete(key);
  let rpc;
  try {
    const processHandle = new AcpProcess({ command, args: descriptor.args, env: environment, label: descriptor.label });
    rpc = new AcpRpcChannel({ processHandle, label: descriptor.label });
    await rpc.ready();
    const initialized = await rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'Cuppet Desktop', version: '0.9.0' },
    }, timeoutMs);
    const verified = initialized?.protocolVersion === 1
      && initialized.agentCapabilities !== null
      && typeof initialized.agentCapabilities === 'object'
      && !Array.isArray(initialized.agentCapabilities);
    if (verified && signature) verifiedExecutables.set(key, { signature, checkedAt: Date.now() });
    return verified;
  } catch {
    return false;
  } finally {
    rpc?.close();
  }
}
