import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  assertLocalProviderVersionSupported,
  localProviderVersionPolicy,
} from './version-policy.mjs';
import { localCliEnvironment, resolveLocalCliExecutable } from '../local-cli-environment.mjs';
import { providerFailureError } from './provider-failure.mjs';

const execFileAsync = promisify(execFile);
const VERSION_TIMEOUT_MS = 8_000;
const MAX_VERSION_OUTPUT_BYTES = 64 * 1024;

export async function verifyLocalProviderExecutableVersion(descriptor, configuration = {}, { runVersionImpl = readExecutableVersion } = {}) {
  const providerID = text(descriptor?.id).toLowerCase();
  const policy = localProviderVersionPolicy(providerID);
  if (!policy) return null;

  const rawCommand = text(configuration?.cliCommand)
    || text(process.env[descriptor?.envOverride])
    || text(descriptor?.command);
  if (!rawCommand) throw new Error(`${text(descriptor?.label) || providerID || 'Provider'} executable is not configured.`);

  const environment = localCliEnvironment(process.env);
  const command = resolveLocalCliExecutable(rawCommand, environment, { environment }) || rawCommand;

  const args = Array.isArray(descriptor?.versionArgs) && descriptor.versionArgs.length
    ? descriptor.versionArgs.map((value) => String(value))
    : ['--version'];

  let result;
  try {
    result = await runVersionImpl(command, args, {
      timeoutMs: VERSION_TIMEOUT_MS,
      env: environment,
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

  const label = firstLine(result?.stdout || result?.stderr);
  return assertLocalProviderVersionSupported(providerID, label, text(descriptor?.label) || providerID);
}

export async function readExecutableVersion(command, args = ['--version'], { timeoutMs = VERSION_TIMEOUT_MS, env = process.env } = {}) {
  const isWindows = process.platform === 'win32';
  const useShell = isWindows && (
    /\.(cmd|bat)$/i.test(command) ||
    !/\.exe$/i.test(command)
  );
  return execFileAsync(command, args, {
    timeout: timeoutMs,
    maxBuffer: MAX_VERSION_OUTPUT_BYTES,
    env,
    windowsHide: true,
    shell: useShell,
  });
}

function firstLine(value) {
  return String(value ?? '').trim().split(/\r?\n/, 1)[0]?.trim() || '';
}

function text(value) {
  return typeof value === 'string' ? value.trim().slice(0, 1000) : '';
}
