export const PROVIDER_OPERATION_NAMES = Object.freeze([
  'detect',
  'probe',
  'install',
  'update',
  'authenticate',
  'disconnect',
  'discoverCapabilities',
  'createRuntime',
]);

const READ_ONLY_OPERATIONS = new Set(['detect', 'probe', 'discoverCapabilities']);
const MUTATING_OPERATIONS = new Set(['install', 'update', 'authenticate', 'disconnect']);

/**
 * Normalizes provider lifecycle operations without inventing support.
 *
 * detect/probe/discoverCapabilities are observational boundaries. They must not
 * install software, launch login UI, change provider configuration, or attach
 * provider-owned tools to a Cuppet session. Mutating operations are explicit.
 */
export function normalizeProviderOperations(input = {}) {
  const source = record(input);
  const operations = {};
  for (const name of PROVIDER_OPERATION_NAMES) {
    if (typeof source[name] === 'function') operations[name] = source[name];
  }
  return Object.freeze(operations);
}

export function providerOperationSupport(operations = {}) {
  const source = record(operations);
  return Object.freeze(Object.fromEntries(PROVIDER_OPERATION_NAMES.map((name) => [name, typeof source[name] === 'function'])));
}

export async function invokeProviderOperation(operations, name, context = {}) {
  if (!PROVIDER_OPERATION_NAMES.includes(name)) throw new Error(`Unknown provider operation '${String(name)}'.`);
  const fn = record(operations)[name];
  if (typeof fn !== 'function') throw unsupportedProviderOperation(name);
  return fn(context);
}

export function providerOperationKind(name) {
  if (READ_ONLY_OPERATIONS.has(name)) return 'read-only';
  if (MUTATING_OPERATIONS.has(name)) return 'mutation';
  if (name === 'createRuntime') return 'runtime';
  return null;
}

export function normalizeProviderInstallation(input = {}) {
  const source = record(input);
  const detected = source.detected === true;
  const installationSource = installationSourceValue(source.source);
  return Object.freeze({
    detected,
    executable: text(source.executable) || null,
    version: text(source.version) || null,
    source: installationSource,
    ownedByCuppet: source.ownedByCuppet === true,
    // Updating an unknown/external install is never inferred from detection.
    canUpdate: detected && installationSource !== 'unknown' && source.ownedByCuppet === true && source.canUpdate === true,
    identity: normalizeExecutableIdentity(source.identity),
  });
}

export function unsupportedProviderOperation(name) {
  const error = new Error(`Provider operation '${String(name)}' is not supported by this backend.`);
  error.code = 'PROVIDER_OPERATION_UNSUPPORTED';
  error.operation = String(name);
  return error;
}

function normalizeExecutableIdentity(value) {
  const source = record(value);
  const resolvedPath = text(source.resolvedPath);
  const realPath = text(source.realPath);
  if (!resolvedPath && !realPath) return null;
  return Object.freeze({
    resolvedPath: resolvedPath || realPath,
    realPath: realPath || resolvedPath,
    ...(finite(source.dev) ? { dev: Number(source.dev) } : {}),
    ...(finite(source.ino) ? { ino: Number(source.ino) } : {}),
    ...(finite(source.size) ? { size: Number(source.size) } : {}),
    ...(finite(source.mtimeMs) ? { mtimeMs: Number(source.mtimeMs) } : {}),
  });
}
function installationSourceValue(value) {
  const normalized = text(value).toLowerCase();
  return ['homebrew', 'npm', 'pnpm', 'bun', 'native', 'managed'].includes(normalized) ? normalized : 'unknown';
}
function finite(value) { return Number.isFinite(Number(value)); }
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
