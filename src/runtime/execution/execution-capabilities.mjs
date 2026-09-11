const EXECUTION_CAPABILITY_KEYS = Object.freeze([
  'inspect',
  'search',
  'batchRead',
  'batchEdit',
  'validate',
  'shell',
  'memory',
  'plan',
  'browser',
]);

/**
 * Cuppet-owned execution capability snapshot.
 *
 * This is intentionally separate from ProviderCapabilities. Provider
 * capabilities describe what a reasoning engine advertises; this contract
 * describes what the current Cuppet runtime can actually execute.
 */
export function executionCapabilities(input = {}) {
  const source = record(input);
  const projectBound = source.projectBound === true;
  const tstConfigured = source.tstConfigured === true;
  const batchEditAvailable = source.batchEditAvailable === true;
  const planAvailable = source.planAvailable === true;
  const browserAvailable = source.browserAvailable === true;
  const shellAvailable = source.shellAvailable !== false;

  return Object.freeze({
    inspect: projectBound && tstConfigured,
    search: projectBound && tstConfigured,
    batchRead: projectBound,
    batchEdit: projectBound && batchEditAvailable,
    validate: projectBound,
    shell: projectBound && shellAvailable,
    memory: tstConfigured,
    plan: planAvailable,
    browser: browserAvailable,
  });
}

export function emptyExecutionCapabilities() {
  return executionCapabilities({ shellAvailable: false });
}

export function isExecutionCapabilities(value) {
  const source = record(value);
  return EXECUTION_CAPABILITY_KEYS.every((key) => typeof source[key] === 'boolean');
}

export function executionCapabilityKeys() {
  return EXECUTION_CAPABILITY_KEYS;
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
