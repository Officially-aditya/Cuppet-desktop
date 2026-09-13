import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  assertLocalProviderVersionSupported,
  localProviderVersionPolicy,
} from './version-policy.mjs';

const execFileAsync = promisify(execFile);
const VERSION_TIMEOUT_MS = 8_000;
const MAX_VERSION_OUTPUT_BYTES = 64 * 1024;

export async function verifyLocalProviderExecutableVersion(descriptor, configuration = {}, { runVersionImpl = readExecutableVersion } = {}) {
  const providerID = text(descriptor?.id).toLowerCase();
  const policy = localProviderVersionPolicy(providerID);
  if (!policy) return null;

  const command = text(configuration?.cliCommand)
    || text(process.env[descriptor?.envOverride])
    || text(descriptor?.command);
  if (!command) throw new Error(`${text(descriptor?.label) || providerID || 'Provider'} executable is not configured.`);

  const args = Array.isArray(descriptor?.versionArgs) && descriptor.versionArgs.length
    ? descriptor.versionArgs.map((value) => String(value))
    : ['--version'];
  const result = await runVersionImpl(command, args, {
    timeoutMs: VERSION_TIMEOUT_MS,
    env: process.env,
  });
  const label = firstLine(result?.stdout || result?.stderr);
  return assertLocalProviderVersionSupported(providerID, label, text(descriptor?.label) || providerID);
}

export async function readExecutableVersion(command, args = ['--version'], { timeoutMs = VERSION_TIMEOUT_MS, env = process.env } = {}) {
  return execFileAsync(command, args, {
    timeout: timeoutMs,
    maxBuffer: MAX_VERSION_OUTPUT_BYTES,
    env,
    windowsHide: true,
  });
}

function firstLine(value) {
  return String(value ?? '').trim().split(/\r?\n/, 1)[0]?.trim() || '';
}

function text(value) {
  return typeof value === 'string' ? value.trim().slice(0, 1000) : '';
}
