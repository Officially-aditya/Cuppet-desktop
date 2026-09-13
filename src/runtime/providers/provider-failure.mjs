const ACTIONS = new Set(['retry', 'retry_later', 'reconnect_provider', 'reauthenticate', 'change_model', 'open_settings']);

export function providerFailureError(message, {
  code = 'PROVIDER_FAILURE',
  category = 'unknown',
  retryable = false,
  action = null,
  providerID = null,
  cause,
  diagnostic = null,
} = {}) {
  const error = new Error(String(message || 'Provider failed.'), cause ? { cause } : undefined);
  error.code = String(code || 'PROVIDER_FAILURE');
  error.providerFailure = Object.freeze({
    category: String(category || 'unknown'),
    retryable: retryable === true,
    action: ACTIONS.has(String(action || '')) ? String(action) : null,
    providerID: text(providerID) || null,
    diagnostic: text(diagnostic, 4000) || null,
  });
  return error;
}

export function providerFailureMetadata(error) {
  const source = error?.providerFailure;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  return {
    category: text(source.category) || 'unknown',
    retryable: source.retryable === true,
    action: ACTIONS.has(String(source.action || '')) ? String(source.action) : null,
    providerID: text(source.providerID) || null,
    diagnostic: text(source.diagnostic, 4000) || null,
  };
}

export function isProviderTransportFailure(error) {
  const metadata = providerFailureMetadata(error);
  if (!metadata) return false;
  return ['executable_missing', 'process_exited', 'transport_closed', 'transport_write', 'protocol_transport'].includes(metadata.category);
}

function text(value, limit = 256) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}
