const ANTHROPIC_VERSION = '2023-06-01';
const FETCH_TIMEOUT_MS = 10_000;

export async function discoverApiCapabilities({ configuration = {}, options = {} } = {}) {
  const providerID = text(configuration.providerID || configuration.primary?.providerID).toLowerCase();
  const apiKey = text(configuration.apiKey);
  if (!providerID) return emptyDiscovery('', 'api', 'No active provider is configured.');
  if (!apiKey) return emptyDiscovery(providerID, 'api', 'Save this provider credential before loading its advertised models.');
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('Model discovery fetch is unavailable.');

  const request = apiCatalogRequest(providerID, configuration.baseUrl, apiKey);
  const payload = await requestJson(fetchImpl, request.url, request.headers);
  const parsed = parseApiCatalog(providerID, payload);
  return {
    providerID,
    source: 'api',
    available: parsed.models.length > 0,
    models: parsed.models,
    settings: [],
    defaultModel: parsed.defaultModel,
    currentModel: null,
    modelDependentSettings: false,
  };
}

export function parseApiCatalog(providerID, payload = {}) {
  const provider = text(providerID).toLowerCase();
  const source = record(payload);
  const rows = provider === 'google'
    ? array(source.models).filter((item) => {
        const methods = array(item?.supportedGenerationMethods ?? item?.supported_generation_methods).map((value) => text(value).toLowerCase());
        return methods.length === 0 || methods.includes('generatecontent') || methods.includes('generate_content');
      })
    : firstArray(source.data, source.models, source.data?.models, source.result?.data, source.result?.models);

  const models = [];
  const seen = new Set();
  for (const raw of rows) {
    const item = record(raw);
    let id = text(item.id || item.model_id || item.modelId || item.model || item.name);
    if (provider === 'google') id = id.replace(/^models\//, '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const rawName = text(item.display_name || item.displayName || item.label || item.name);
    const label = rawName && rawName !== `models/${id}` && rawName !== id ? rawName : id;
    const description = text(item.description || item.summary);
    const context = positiveInt(item.context_length ?? item.contextWindow ?? item.max_input_tokens ?? item.inputTokenLimit);
    const outputLimit = positiveInt(item.max_completion_tokens ?? item.output_limit ?? item.max_tokens ?? item.outputTokenLimit ?? item.top_provider?.max_completion_tokens);
    models.push({
      id,
      label,
      ...(description ? { description } : {}),
      ...(context ? { context } : {}),
      ...(outputLimit ? { outputLimit } : {}),
      ...(explicitDefault(item) ? { isDefault: true } : {}),
    });
    if (models.length >= 512) break;
  }

  const declaredDefault = text(source.default_model || source.defaultModel || source.current_model || source.currentModel);
  const rowDefault = models.find((item) => item.isDefault)?.id || '';
  const defaultModel = models.some((item) => item.id === declaredDefault) ? declaredDefault : rowDefault || null;
  return { models, defaultModel };
}

function apiCatalogRequest(providerID, baseUrlValue, apiKey) {
  const provider = text(providerID).toLowerCase();
  const baseUrl = stripSlash(text(baseUrlValue));
  if (!baseUrl) throw new Error('Provider base URL is unavailable.');
  if (provider === 'anthropic') return {
    url: `${baseUrl}/models?limit=1000`,
    headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION, accept: 'application/json' },
  };
  if (provider === 'google') return {
    url: `${baseUrl}/models`,
    headers: { 'x-goog-api-key': apiKey, accept: 'application/json' },
  };
  if (provider === 'qwen') {
    const root = baseUrl.replace(/\/compatible-mode\/v1$/i, '/api/v1');
    return { url: `${root}/models?providers=qwen`, headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' } };
  }
  const suffix = provider === 'openrouter' ? '/models?supported_parameters=tools' : '/models';
  return { url: `${baseUrl}${suffix}`, headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' } };
}

async function requestJson(fetchImpl, url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal, cache: 'no-store' });
    if (!response?.ok) {
      let detail = '';
      try {
        const payload = await response.json();
        detail = text(payload?.error?.message || payload?.message || payload?.error);
      } catch {}
      throw new Error(`Model catalog request failed (${Number(response?.status) || 0})${detail ? `: ${detail}` : ''}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function emptyDiscovery(providerID, source, error) {
  return { providerID, source, available: false, models: [], settings: [], defaultModel: null, currentModel: null, modelDependentSettings: false, ...(error ? { error } : {}) };
}
function explicitDefault(item) { return item?.is_default === true || item?.isDefault === true || item?.default === true; }
function firstArray(...values) { return values.find(Array.isArray) ?? []; }
function positiveInt(value) { const number = Number(value); return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0; }
function stripSlash(value) { return value.replace(/\/+$/, ''); }
function text(value) { return typeof value === 'string' ? value.trim().slice(0, 1000) : ''; }
function array(value) { return Array.isArray(value) ? value : []; }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
