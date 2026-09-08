const PROVIDER_OVERRIDES = Object.freeze({
  anthropic: Object.freeze({ label: 'Anthropic', description: 'Claude models' }),
  openai: Object.freeze({
    label: 'OpenAI',
    description: 'OpenAI and Azure OpenAI models',
    integrationIds: Object.freeze(['openai', 'azure', 'azure-openai']),
  }),
  google: Object.freeze({ label: 'Google', description: 'Gemini API models' }),
  vertex: Object.freeze({
    label: 'Vertex AI',
    description: 'Google Cloud ADC models',
    integrationIds: Object.freeze(['google-vertex', 'google-vertex-anthropic', 'vertex']),
    specialization: 'vertex',
  }),
});

const DISPLAY_ACRONYMS = new Map([
  ['ai', 'AI'], ['api', 'API'], ['adc', 'ADC'], ['azure', 'Azure'], ['gpt', 'GPT'],
  ['llm', 'LLM'], ['nim', 'NIM'], ['nvidia', 'NVIDIA'], ['openai', 'OpenAI'],
]);

export { PROVIDER_OVERRIDES };

/**
 * Build the non-secret Cuppet provider catalog from live model/integration
 * projections. This is deliberately not a closed provider registry: unknown
 * provider IDs are included automatically and only Cuppet-specific alias
 * groups live in PROVIDER_OVERRIDES.
 */
export function buildProviderCatalog(models = [], integrations = []) {
  const observed = new Set();
  for (const model of models) addObserved(observed, model?.providerID);
  for (const integration of integrations) addObserved(observed, integration?.id);

  const groups = new Map();
  for (const sourceID of observed) {
    const group = providerGroupFor(sourceID);
    const current = groups.get(group.id) ?? { sourceIDs: new Set(), override: group.override };
    current.sourceIDs.add(sourceID);
    groups.set(group.id, current);
  }

  return [...groups.entries()].map(([id, group]) => {
    const integrationIds = uniqueIDs([id, ...(group.override?.integrationIds ?? []), ...group.sourceIDs]);
    const groupModels = models.filter((model) => matchesAnyID(model?.providerID, integrationIds));
    const groupIntegrations = integrations.filter((integration) => matchesAnyID(integration?.id, integrationIds));
    const capabilities = capabilitiesFor(groupModels);
    const label = group.override?.label ?? humanizeProviderId(id);
    return {
      id,
      label,
      description: group.override?.description ?? `${label} models`,
      integrationIds,
      capabilities,
      modelCount: groupModels.length,
      integrationCount: groupIntegrations.length,
      ...(group.override?.specialization ? { specialization: group.override.specialization } : {}),
    };
  }).sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

export function humanizeProviderId(value) {
  const id = normalizeProviderID(value);
  if (!id) return String(value ?? '');
  return id.split(/[-_.\s]+/).filter(Boolean).map((word) => DISPLAY_ACRONYMS.get(word) ?? `${word[0].toUpperCase()}${word.slice(1)}`).join(' ');
}

export function providerDescriptorFor(providerID, catalog = []) {
  const normalized = normalizeProviderID(providerID);
  return catalog.find((provider) => normalizeProviderID(provider?.id) === normalized || (provider?.integrationIds ?? []).some((id) => normalizeProviderID(id) === normalized));
}

export function modelMatchesProvider(model, provider) {
  const descriptor = typeof provider === 'string' ? descriptorForID(provider) : provider;
  return Boolean(descriptor?.integrationIds?.some((id) => sameProviderID(model?.providerID, id)));
}

export function integrationMatchesProvider(integration, provider) {
  const descriptor = typeof provider === 'string' ? descriptorForID(provider) : provider;
  return Boolean(descriptor?.integrationIds?.some((id) => sameProviderID(integration?.id, id)));
}

export function modelSupportsCodingAgent(model) {
  const capabilities = record(model?.capabilities);
  const input = stringArray(capabilities.input);
  const output = stringArray(capabilities.output);
  return input.includes('text') && output.includes('text') && capabilities.tools === true && capabilities.streaming !== false;
}

export function modelsForProvider(models, provider, { codingOnly = true } = {}) {
  return (Array.isArray(models) ? models : []).filter((model) => modelMatchesProvider(model, provider) && (!codingOnly || modelSupportsCodingAgent(model)));
}

export function missingCodingAgentCapabilities(provider) {
  const missing = [];
  const capabilities = record(provider?.capabilities);
  if (capabilities.chat !== true) missing.push('chat');
  if (capabilities.streaming !== true) missing.push('streaming');
  if (capabilities.tools !== true) missing.push('tool calling');
  if (!missing.length && capabilities.codingAgent !== true) missing.push('a model with both streaming and tool calling');
  return missing;
}

/**
 * Resolve a persisted/legacy model ref against the live catalog. Exact live
 * provider IDs win; aliases such as `vertex` may migrate to a concrete live
 * provider carrying the same model ID. Returns null rather than guessing a
 * different model when the requested ID is unavailable.
 */
export function resolveLiveModelRef(selection, models = []) {
  const providerID = normalizeProviderID(selection?.providerID);
  const modelID = typeof selection?.modelID === 'string' ? selection.modelID.trim() : '';
  if (!providerID || !modelID) return null;
  const enabled = models.filter((model) => model?.enabled !== false && model?.status !== 'disabled');
  const exact = enabled.find((model) => sameProviderID(model?.providerID, providerID) && model?.modelID === modelID);
  if (exact) return preserveVariant(exact, selection);
  const descriptor = descriptorForID(providerID);
  const grouped = enabled.find((model) => model?.modelID === modelID && modelMatchesProvider(model, descriptor));
  return grouped ? preserveVariant(grouped, selection) : null;
}

export function validateCodingModel(model) {
  if (!model) throw new Error('model is unavailable');
  if (!modelSupportsCodingAgent(model)) throw new Error(`${model.providerID}/${model.modelID} does not support text coding tools and streaming`);
  return model;
}

function capabilitiesFor(models) {
  const chatModels = models.filter(isChatModel);
  const streamingModels = chatModels.filter((model) => record(model?.capabilities).streaming !== false);
  const toolModels = chatModels.filter((model) => record(model?.capabilities).tools === true);
  return {
    chat: chatModels.length > 0,
    streaming: streamingModels.length > 0,
    tools: toolModels.length > 0,
    codingAgent: models.some(modelSupportsCodingAgent),
  };
}

function isChatModel(model) {
  const capabilities = record(model?.capabilities);
  return stringArray(capabilities.input).includes('text') && stringArray(capabilities.output).includes('text');
}

function descriptorForID(providerID) {
  const group = providerGroupFor(providerID);
  const label = group.override?.label ?? humanizeProviderId(group.id);
  return {
    id: group.id,
    label,
    description: group.override?.description ?? `${label} models`,
    integrationIds: uniqueIDs([group.id, ...(group.override?.integrationIds ?? [])]),
    capabilities: { chat: false, streaming: false, tools: false, codingAgent: false },
    modelCount: 0,
    integrationCount: 0,
    ...(group.override?.specialization ? { specialization: group.override.specialization } : {}),
  };
}

function providerGroupFor(providerID) {
  const normalized = normalizeProviderID(providerID);
  for (const [id, override] of Object.entries(PROVIDER_OVERRIDES)) {
    if (normalized === id || override.integrationIds?.some((candidate) => normalizeProviderID(candidate) === normalized)) return { id, override };
  }
  return { id: normalized, override: undefined };
}

function preserveVariant(model, selection) {
  return {
    providerID: String(model.providerID),
    modelID: String(model.modelID),
    ...(typeof selection?.variant === 'string' && selection.variant.trim() ? { variant: selection.variant.trim() } : {}),
  };
}
function addObserved(target, value) { const normalized = normalizeProviderID(value); if (normalized) target.add(normalized); }
function uniqueIDs(values) { return [...new Set(values.map(normalizeProviderID).filter(Boolean))]; }
function matchesAnyID(value, ids) { return ids.some((id) => sameProviderID(value, id)); }
function sameProviderID(left, right) { return normalizeProviderID(left) === normalizeProviderID(right); }
function normalizeProviderID(value) { return typeof value === 'string' ? value.trim().toLowerCase() : ''; }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function stringArray(value) { return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []; }
