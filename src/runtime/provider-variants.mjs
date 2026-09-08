const SECRET_KEYS = new Set([
  'apikey', 'authtoken', 'accesstoken', 'refreshtoken', 'authorization',
  'password', 'clientsecret', 'credential', 'headers',
]);

const OPENAI_COMPATIBLE_PACKAGES = new Set([
  '@ai-sdk/openai-compatible', '@ai-sdk/cerebras', '@ai-sdk/deepinfra', '@ai-sdk/groq',
  '@ai-sdk/mistral', '@ai-sdk/togetherai', '@ai-sdk/xai', '@openrouter/ai-sdk-provider',
  'ai-gateway-provider', 'venice-ai-sdk-provider',
]);

/**
 * Reconstruct missing live variant metadata from a secondary provider
 * projection. Returned data is non-secret by construction and may therefore
 * be persisted/projected independently from provider credentials.
 */
export function buildVariantBridge(models = [], providers = []) {
  const providerMap = new Map((Array.isArray(providers) ? providers : []).map((provider) => [provider?.id, provider]));
  return {
    schema: 1,
    models: (Array.isArray(models) ? models : []).flatMap((model) => {
      const modelID = String(model?.modelID ?? model?.id ?? '');
      const source = providerMap.get(model?.providerID)?.models?.[modelID];
      const existing = new Set(normalizedVariants(model?.variants).map((variant) => variant.id));
      const variants = Object.entries(record(source?.variants)).flatMap(([id, options]) => {
        if (!id || existing.has(id) || !isRecord(options)) return [];
        return [{ id, headers: {}, body: lowerVariant(model, sanitizeVariantOptions(options)) }];
      });
      return variants.length ? [{ providerID: String(model?.providerID ?? ''), modelID, variants }] : [];
    }),
  };
}

export function sanitizeVariantOptions(value) {
  if (Array.isArray(value)) return value.map((entry) => isRecord(entry) || Array.isArray(entry) ? sanitizeVariantOptions(entry) : entry);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    const normalized = key.replaceAll(/[-_]/g, '').toLowerCase();
    if (SECRET_KEYS.has(normalized)) return [];
    if (Array.isArray(item) || isRecord(item)) return [[key, sanitizeVariantOptions(item)]];
    return [[key, item]];
  }));
}

/** Return the model's available effort/variant IDs with live metadata winning. */
export function effortOptions(model, bridge = { models: [] }) {
  const live = normalizedVariants(model?.variants).map((variant) => variant.id);
  if (live.length) return unique(live);
  const bridged = bridgeEntry(bridge, model)?.variants ?? [];
  return unique(bridged.map((variant) => String(variant?.id ?? '')).filter(Boolean));
}

export function selectEffort(modelRef, requested, model, bridge = { models: [] }) {
  const options = effortOptions(model, bridge);
  const normalized = String(requested ?? '').trim().toLowerCase();
  const selected = options.find((option) => option.toLowerCase() === normalized);
  if (!selected) throw new Error(`Unknown effort '${String(requested ?? '')}'. Available: ${options.join(', ') || 'none'}`);
  return { providerID: String(modelRef?.providerID ?? model?.providerID ?? ''), modelID: String(modelRef?.modelID ?? model?.modelID ?? model?.id ?? ''), variant: selected };
}

/**
 * Resolve sanitized request metadata for a selected variant. Live variant
 * bodies win; bridged metadata is fallback only. A fresh clone is returned so
 * callers cannot mutate shared catalog state.
 */
export function variantRequest(model, variantID, bridge = { models: [] }) {
  const id = String(variantID ?? '').trim();
  if (!id) return null;
  const live = normalizedVariants(model?.variants).find((variant) => variant.id === id);
  if (live) return cloneVariant(live);
  const bridged = (bridgeEntry(bridge, model)?.variants ?? []).find((variant) => variant?.id === id);
  return bridged ? cloneVariant(bridged) : null;
}

function lowerVariant(model, options) {
  const base = record(model?.request?.body);
  if (model?.api?.type !== 'aisdk') return mergeNestedRequest(base, record(options));
  const packageName = String(model?.api?.package ?? '');
  let body;
  if (packageName === '@ai-sdk/openai' || packageName === '@ai-sdk/azure') {
    body = snake(record(options));
    if (options.reasoningEffort !== undefined || options.reasoningSummary !== undefined) {
      body.reasoning = {
        ...record(body.reasoning),
        ...(options.reasoningEffort !== undefined ? { effort: options.reasoningEffort } : {}),
        ...(options.reasoningSummary !== undefined ? { summary: options.reasoningSummary } : {}),
      };
      delete body.reasoning_effort;
      delete body.reasoning_summary;
    }
    if (options.textVerbosity !== undefined) {
      body.text = { ...record(body.text), verbosity: options.textVerbosity };
      delete body.text_verbosity;
    }
  } else if (packageName === '@ai-sdk/anthropic' || packageName === '@ai-sdk/google-vertex/anthropic') {
    body = snake(record(options));
    if (options.effort !== undefined || options.taskBudget !== undefined) {
      body.output_config = compact({ effort: options.effort, task_budget: options.taskBudget });
      delete body.effort; delete body.task_budget;
    }
  } else if (packageName === '@ai-sdk/google' || packageName === '@ai-sdk/google-vertex') {
    const generationKeys = new Set(['thinkingConfig', 'responseModalities', 'mediaResolution', 'imageConfig']);
    const entries = Object.entries(record(options));
    const generationConfig = Object.fromEntries(entries.filter(([key]) => generationKeys.has(key)));
    body = {
      ...Object.fromEntries(entries.filter(([key]) => !generationKeys.has(key))),
      ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
    };
  } else if (packageName === '@ai-sdk/amazon-bedrock') {
    body = { additionalModelRequestFields: record(options) };
  } else if (OPENAI_COMPATIBLE_PACKAGES.has(packageName)) {
    body = { ...record(options) };
    if (options.reasoningEffort !== undefined) {
      body.reasoning_effort = options.reasoningEffort;
      delete body.reasoningEffort;
    }
  } else body = { ...record(options) };
  return mergeNestedRequest(base, body);
}

function bridgeEntry(bridge, model) {
  const providerID = String(model?.providerID ?? '');
  const modelID = String(model?.modelID ?? model?.id ?? '');
  return (Array.isArray(bridge?.models) ? bridge.models : []).find((entry) => entry?.providerID === providerID && entry?.modelID === modelID);
}
function normalizedVariants(value) {
  if (Array.isArray(value)) return value.flatMap((variant) => typeof variant?.id === 'string' && variant.id ? [{ id: variant.id, headers: record(variant.headers), body: sanitizeVariantOptions(record(variant.body)) }] : []);
  if (isRecord(value)) return Object.entries(value).flatMap(([id, body]) => id && isRecord(body) ? [{ id, headers: {}, body: sanitizeVariantOptions(body) }] : []);
  return [];
}
function cloneVariant(variant) { return { id: variant.id, headers: structuredClone(record(variant.headers)), body: structuredClone(record(variant.body)) }; }
function mergeNestedRequest(base, variant) {
  return Object.fromEntries(Object.entries(variant).map(([key, value]) => [key, isRecord(base[key]) && isRecord(value) ? deepMerge(base[key], value) : value]));
}
function deepMerge(base, override) {
  return { ...base, ...Object.fromEntries(Object.entries(override).map(([key, value]) => [key, isRecord(base[key]) && isRecord(value) ? deepMerge(base[key], value) : value])) };
}
function snake(value) { return Object.fromEntries(Object.entries(value).map(([key, item]) => [snakeKey(key), snakeValue(item)])); }
function snakeValue(value) { if (Array.isArray(value)) return value.map(snakeValue); if (!isRecord(value)) return value; return snake(value); }
function snakeKey(key) { return key.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`); }
function compact(value) { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)); }
function unique(values) { return [...new Set(values)]; }
function record(value) { return isRecord(value) ? value : {}; }
function isRecord(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }
