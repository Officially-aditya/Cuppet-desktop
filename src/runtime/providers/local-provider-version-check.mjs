import {
  assertLocalProviderVersionSupported,
  localProviderVersionPolicy,
  localProviderVersionLabel,
} from './version-policy.mjs';
import { localCliEnvironment, resolveLocalCliExecutable } from '../local-cli-environment.mjs';
import { providerFailureError } from './provider-failure.mjs';
import { probeProviderCommand, providerProcessEnvironment, runProviderCommand } from './cli-command.mjs';

const VERSION_TIMEOUT_MS = 8_000;
const VERSION_CACHE_TTL_MS = 30 * 60_000;
const versionCache = new Map();

export function clearLocalProviderVersionCache(providerID) {
  if (providerID) {
    const prefix = `${String(providerID).toLowerCase()}:`;
    for (const key of versionCache.keys()) {
      if (key.startsWith(prefix)) versionCache.delete(key);
    }
  } else {
    versionCache.clear();
  }
}

export async function verifyLocalProviderExecutableVersion(descriptor, configuration = {}, { runVersionImpl = readExecutableVersion, force = false } = {}) {
  const providerID = text(descriptor?.id).toLowerCase();
  const policy = localProviderVersionPolicy(providerID);
  if (!policy) return null;

  const environment = localCliEnvironment({ ...process.env, ...(configuration?.cliEnv ?? {}) });
  const rawCommand = text(configuration?.cliCommand)
    || text(environment[descriptor?.envOverride])
    || text(descriptor?.command);
  if (!rawCommand) throw new Error(`${text(descriptor?.label) || providerID || 'Provider'} executable is not configured.`);

  const command = resolveLocalCliExecutable(rawCommand, environment, { environment }) || rawCommand;

  const args = Array.isArray(descriptor?.versionArgs) && descriptor.versionArgs.length
    ? descriptor.versionArgs.map((value) => String(value))
    : ['--version'];

  const cacheKey = `${providerID}:${command}:${args.join(' ')}`;
  if (!force) {
    const cached = versionCache.get(cacheKey);
    if (cached && (Date.now() - cached.at) < VERSION_CACHE_TTL_MS) {
      return assertLocalProviderVersionSupported(providerID, cached.label, text(descriptor?.label) || providerID);
    }
  }

  let result;
  try {
    result = await probeProviderCommand(command, args, {
      runImpl: (executable, arguments_, timeoutMs, options) => runVersionImpl(executable, arguments_, { timeoutMs, env: providerProcessEnvironment(options.env) }),
      timeoutMs: VERSION_TIMEOUT_MS, env: environment,
    });
  } catch (error) {
    const errorMsg = String(error?.message ?? error ?? '');
    const isMissing = error?.code === 'ENOENT' ||
      /not found|ENOENT|command not found|is not recognized as an internal or external command/i.test(errorMsg);
    if (isMissing) {
      throw providerFailureError(
        `${text(descriptor?.label) || providerID || 'Provider'} CLI was not found (${command}).`,
        {
          code: 'PROVIDER_EXECUTABLE_MISSING',
          category: 'executable_missing',
          retryable: false,
          action: 'reconnect_provider',
          cause: error,
          diagnostic: errorMsg,
        },
      );
    }
    throw error;
  }

  const label = localProviderVersionLabel(providerID, result);
  const verified = assertLocalProviderVersionSupported(providerID, label, text(descriptor?.label) || providerID);
  versionCache.set(cacheKey, { label, at: Date.now() });
  return verified;
}

export async function readExecutableVersion(command, args = ['--version'], { timeoutMs = VERSION_TIMEOUT_MS, env = process.env } = {}) {
  return runProviderCommand(command, args, timeoutMs, { env });
}

function text(value) {
  return typeof value === 'string' ? value.trim().slice(0, 1000) : '';
}
