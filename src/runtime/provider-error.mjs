const ACCOUNT_PROVIDERS = new Set(['codex','opencode','grok-build','github-copilot','mistral-vibe','kiro','antigravity']);

const LABELS = Object.freeze({
  codex: 'ChatGPT / Codex',
  opencode: 'OpenCode',
  'grok-build': 'Grok Build',
  'github-copilot': 'GitHub Copilot',
  'mistral-vibe': 'Mistral Vibe',
  kiro: 'Kiro',
  antigravity: 'Google Antigravity',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
  'vertex-gemini': 'Google Vertex AI',
  deepseek: 'DeepSeek',
  kimi: 'Kimi',
  zai: 'Z.ai',
});

export function classifyProviderError(error, context = {}) {
  const raw = cleanError(error);
  const providerID = providerId(context);
  const provider = providerLabel(providerID, context.providerLabel);
  const lower = raw.toLowerCase();
  const status = statusCode(error, raw);

  if (matches(lower, [
    'context length', 'context_length', 'maximum context', 'max context', 'prompt is too long',
    'too many tokens', 'token limit exceeded', 'input is too long', 'request too large',
  ])) return failure('context_limit', 'Conversation is too large', `${provider} cannot fit this conversation in the selected model's context window. Start a new chat, compact the conversation, or choose a model with a larger context window.`, 'change_context', raw, providerID, provider);

  if (status === 429 || matches(lower, [
    'rate limit', 'rate_limit', 'too many requests', 'resource_exhausted', 'resource exhausted',
    'requests per minute', 'tokens per minute', 'requests per day', 'usage limit reached',
    'weekly limit', 'daily limit', 'capacity limit', 'retry after', 'retry-after',
  ])) return failure('rate_limit', 'Rate limit reached', `You've reached ${provider}'s current request or usage limit. Wait for the provider to reset the allowance, then retry, or switch providers.`, 'retry_later', raw, providerID, provider);

  if (status === 402 || matches(lower, [
    'insufficient_quota', 'insufficient quota', 'quota exceeded', 'quota_exceeded', 'credits exhausted',
    'credit balance', 'billing', 'payment required', 'spending limit', 'no credits', 'out of credits',
  ])) return failure('quota_exhausted', 'Provider allowance exhausted', `${provider} reports that this account has no remaining allowance or credits. Wait for the plan to reset, add provider billing/credits if applicable, or switch providers.`, 'provider_billing', raw, providerID, provider);

  if (status === 401 || status === 403 || matches(lower, [
    'unauthorized', 'unauthenticated', 'authentication failed', 'authentication error', 'invalid api key',
    'invalid_api_key', 'invalid token', 'token expired', 'expired token', 'session expired', 'login expired',
    'not logged in', 'not authenticated', 'sign in required', 'signin required', 'login required',
    'credentials expired', 'oauth expired', 'access denied', 'forbidden',
  ])) {
    const accountProvider = ACCOUNT_PROVIDERS.has(providerID);
    return failure(
      'authentication',
      'Sign-in required',
      accountProvider
        ? `${provider}'s login is missing or expired. Reconnect ${provider} in Settings → Platform and complete the provider's sign-in again.`
        : `${provider} rejected the saved credential. Update the API key or provider credentials in Settings → Platform and try again.`,
      'reauthenticate', raw, providerID, provider,
    );
  }

  if (matches(lower, [
    'model not found', 'model_not_found', 'unknown model', 'invalid model', 'unsupported model',
    'model is not available', 'model unavailable', 'does not have access to model', 'model access',
  ])) return failure('model_unavailable', 'Model unavailable', `${provider} cannot use the selected model for this account. Choose another model in Settings → Platform and retry.`, 'change_model', raw, providerID, provider);

  if (matches(lower, [
    'enoent', 'cli was not found', 'command not found', 'could not find the cli', 'executable not found',
    'app-server is unavailable', 'agent stdio exited', 'acp exited',
  ])) return failure('local_agent_unavailable', 'Provider connection needs repair', `${provider}'s local agent is missing or stopped unexpectedly. Reconnect ${provider} in Settings → Platform; Cuppet will repair the local setup automatically.`, 'reconnect_provider', raw, providerID, provider);

  if (matches(lower, ['timed out', 'timeout', 'deadline exceeded', 'etimedout'])) return failure('timeout', 'Provider timed out', `${provider} took too long to respond. Retry the request; if it keeps happening, switch providers or try again later.`, 'retry', raw, providerID, provider);

  if (matches(lower, [
    'enotfound', 'econnrefused', 'econnreset', 'ehostunreach', 'enetunreach', 'network error',
    'fetch failed', 'socket hang up', 'socket closed', 'dns', 'offline', 'connection refused',
    'connection reset', 'unable to connect', 'could not connect',
  ])) return failure('network', 'Could not reach provider', `Cuppet could not reach ${provider}. Check the network connection and retry.`, 'retry', raw, providerID, provider);

  if (status >= 500 || matches(lower, [
    'service unavailable', 'temporarily unavailable', 'provider unavailable', 'overloaded', 'server overloaded',
    'internal server error', 'bad gateway', 'gateway timeout', 'upstream error', 'server error',
    'provider failed', 'capacity unavailable',
  ])) return failure('provider_unavailable', 'Provider is unavailable', `${provider} is currently failing or unavailable. Retry in a moment or switch providers.`, 'retry_later', raw, providerID, provider);

  if (matches(lower, [
    'streaming failed', 'stream failed', 'malformed streaming', 'malformed streaming json',
    'stream completed without', 'stream ended', 'unexpected end of stream', 'incomplete stream',
    'closed during turn', 'exited during turn', 'returned no response', 'empty assistant response',
  ])) return failure('streaming', 'Provider response was interrupted', `${provider}'s response stream ended unexpectedly. Retry the request. If this repeats, the provider may be unstable right now.`, 'retry', raw, providerID, provider);

  if (matches(lower, ['api key is required', 'model is required', 'provider settings', 'providerconfigurationerror'])) return failure('configuration', 'Provider setup is incomplete', `${provider} is not fully configured. Open Settings → Platform and finish the provider setup.`, 'open_settings', raw, providerID, provider);

  return failure('unknown', `${provider} failed`, `${provider} returned an unexpected error. Retry once; if it continues, reconnect or switch providers.`, 'retry', raw, providerID, provider);
}

function failure(category, title, message, action, diagnostic, providerID, provider) {
  return {
    category,
    title,
    message,
    action,
    providerID,
    provider,
    diagnostic,
    chatMessage: `**${title}**\n\n${message}`,
    toastMessage: `${title} — ${message}`,
  };
}

function providerId(context) {
  const direct = text(context?.providerID);
  if (direct) return direct.toLowerCase();
  const provider = context?.provider && typeof context.provider === 'object' ? context.provider : {};
  return (text(provider.providerID) || text(provider.primary?.providerID) || text(provider.presetID) || 'provider').toLowerCase();
}
function providerLabel(providerID, explicit) {
  return text(explicit) || LABELS[providerID] || titleCase(providerID === 'provider' ? 'Provider' : providerID);
}
function statusCode(error, raw) {
  const direct = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  if (Number.isInteger(direct) && direct >= 100 && direct <= 599) return direct;
  const match = String(raw).match(/(?:failed|error|status|http)[^\d]{0,12}\(?([1-5]\d\d)\)?/i) || String(raw).match(/^([1-5]\d\d)\b/);
  return match ? Number(match[1]) : 0;
}
function matches(value, needles) { return needles.some((needle) => value.includes(needle)); }
function titleCase(value) { return String(value).split(/[-_\s]+/).filter(Boolean).map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`).join(' '); }
function text(value) { return typeof value === 'string' ? value.trim().slice(0, 160) : ''; }
function cleanError(error) {
  const value = error instanceof Error ? `${error.name && error.name !== 'Error' ? `${error.name}: ` : ''}${error.message}` : String(error ?? '');
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    .replace(/(?:api[_-]?key|token|secret)\s*[=:]\s*[A-Za-z0-9._~+/=-]{12,}/gi, '$1=[redacted]')
    .slice(0, 4000);
}
