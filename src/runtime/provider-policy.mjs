import {
  buildProviderCatalog,
  modelSupportsCodingAgent,
  modelsForProvider,
  resolveLiveModelRef,
  validateCodingModel,
} from './provider-catalog.mjs';
import { effortOptions, sanitizeVariantOptions, variantRequest } from './provider-variants.mjs';

export const DEFAULT_PROVIDER_ID = 'openai-compatible';
export const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * Normalize one host provider connection into a secret-bearing execution
 * configuration plus a credential-free model catalog. The catalog is open:
 * any provider id can participate as long as its models satisfy the coding
 * capability contract. Provider-specific HTTP adapters can be added later
 * without changing role/selection semantics.
 */
export function normalizeProviderConfiguration(input = {}) {
  const source = record(input);
  const providerID = string(source.providerID) || string(source.provider) || DEFAULT_PROVIDER_ID;
  const baseUrl = normalizeBaseUrl(string(source.baseUrl) || DEFAULT_BASE_URL);
  const apiKey = string(source.apiKey);
  const contextWindow = boundedContext(source.contextWindow);
  const integrations = sanitizeIntegrations(source.integrations, providerID);
  const variantBridge = sanitizeVariantBridge(source.variantBridge);
  const models = sanitizeModels(source.models);

  const legacyPrimary = string(source.model);
  const legacySecondary = string(source.backgroundModel);
  const requestedPrimary = normalizeRef(source.primary, providerID, legacyPrimary, string(source.primaryEffort) || string(source.effort));
  const requestedSecondary = normalizeRef(source.secondary, providerID, legacySecondary || legacyPrimary, string(source.secondaryEffort) || string(source.backgroundEffort));

  ensureConfiguredModel(models, requestedPrimary, source.primaryModel);
  ensureConfiguredModel(models, requestedSecondary, source.secondaryModel);
  if (!models.length && legacyPrimary) ensureConfiguredModel(models, { providerID, modelID: legacyPrimary }, undefined);
  if (legacySecondary) ensureConfiguredModel(models, { providerID, modelID: legacySecondary }, undefined);

  const primary = resolveSelection(requestedPrimary, models, variantBridge);
  const secondary = resolveSelection(requestedSecondary, models, variantBridge) ?? primary;
  const primaryModel = findModel(models, primary);
  const effectiveContext = Number.isFinite(primaryModel?.context) ? boundedContext(primaryModel.context) : contextWindow;

  return {
    schema: 1,
    providerID,
    baseUrl,
    apiKey,
    contextWindow: effectiveContext,
    integrations,
    models,
    variantBridge,
    primary,
    secondary,
    // Compatibility aliases for Phase A/C2 callers. They are projections of
    // role authority, not separate model authorities.
    model: primary?.modelID ?? '',
    backgroundModel: secondary?.modelID ?? primary?.modelID ?? '',
  };
}

export function providerProjection(input = {}, { includeEndpoint = false } = {}) {
  const config = normalizeProviderConfiguration(input);
  const catalog = buildProviderCatalog(config.models, config.integrations);
  const primaryModel = findModel(config.models, config.primary);
  const secondaryModel = findModel(config.models, config.secondary);
  const models = config.models.filter(modelSupportsCodingAgent).map((model) => ({
    providerID: model.providerID,
    modelID: model.modelID,
    name: model.name,
    context: model.context,
    outputLimit: model.outputLimit,
    capabilities: structuredClone(model.capabilities),
    variants: effortOptions(model, config.variantBridge),
    roles: [
      ...(sameRef(model, config.primary) ? ['primary'] : []),
      ...(sameRef(model, config.secondary) ? ['secondary'] : []),
    ],
  }));
  return {
    schema: 1,
    providerID: config.providerID,
    configured: Boolean(config.apiKey && config.primary && primaryModel),
    catalog,
    models,
    primary: config.primary ? { ...config.primary } : null,
    secondary: config.secondary ? { ...config.secondary } : null,
    primaryEfforts: primaryModel ? effortOptions(primaryModel, config.variantBridge) : [],
    secondaryEfforts: secondaryModel ? effortOptions(secondaryModel, config.variantBridge) : [],
    model: config.primary?.modelID ?? '',
    backgroundModel: config.secondary?.modelID ?? '',
    ...(includeEndpoint ? { baseUrl: config.baseUrl } : {}),
  };
}

export function resolveAdvertisedSelection(input, requested) {
  const config = normalizeProviderConfiguration(input);
  const raw = normalizeRef(requested, config.providerID, '', '');
  if (!raw?.modelID) throw new Error('modelID is required');
  const resolved = resolveLiveModelRef(raw, config.models);
  if (!resolved) throw new Error(`${raw.providerID}/${raw.modelID} is not configured on this host`);
  const model = findModel(config.models, resolved);
  validateCodingModel(model);
  if (!raw.variant) return { providerID: resolved.providerID, modelID: resolved.modelID };
  const available = effortOptions(model, config.variantBridge);
  const selected = available.find((option) => option.toLowerCase() === raw.variant.toLowerCase());
  if (!selected) throw new Error(`Unknown effort '${raw.variant}'. Available: ${available.join(', ') || 'none'}`);
  return { providerID: resolved.providerID, modelID: resolved.modelID, variant: selected };
}

export function selectionForRole(input, role = 'primary') {
  const config = normalizeProviderConfiguration(input);
  const selected = role === 'secondary' ? config.secondary : config.primary;
  return selected ? { ...selected } : null;
}

export function modelsForSelectionProvider(input, providerID) {
  const config = normalizeProviderConfiguration(input);
  return modelsForProvider(config.models, providerID).map((model) => ({
    providerID: model.providerID,
    modelID: model.modelID,
    variants: effortOptions(model, config.variantBridge),
  }));
}

/**
 * Lower a host-advertised selection into the execution adapter request. The
 * selected effort stays request metadata; it is never inserted into prompt
 * text. Variant metadata is already sanitized before reaching this boundary.
 */
export function providerRequest(input, roleOrSelection = 'primary') {
  const config = normalizeProviderConfiguration(input);
  if (!config.apiKey) throw new Error('An API key is required. Open Provider settings and add one.');
  const selection = typeof roleOrSelection === 'string'
    ? (roleOrSelection === 'secondary' ? config.secondary : config.primary)
    : resolveAdvertisedSelection(config, roleOrSelection);
  if (!selection) throw new Error(`No ${typeof roleOrSelection === 'string' ? roleOrSelection : 'selected'} model is configured`);
  const model = findModel(config.models, selection);
  validateCodingModel(model);
  const variant = selection.variant ? variantRequest(model, selection.variant, config.variantBridge) : null;
  if (selection.variant && !variant) throw new Error(`Variant '${selection.variant}' is no longer available for ${model.providerID}/${model.modelID}`);
  return {
    providerID: model.providerID,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: string(model.api?.id) || model.modelID,
    modelID: model.modelID,
    contextWindow: Number.isFinite(model.context) ? boundedContext(model.context) : config.contextWindow,
    variant: selection.variant ?? null,
    requestHeaders: deepMerge(record(model.request?.headers), record(variant?.headers)),
    requestBody: deepMerge(record(model.request?.body), record(variant?.body)),
  };
}

export function serializableProviderConfiguration(input = {}) {
  const config = normalizeProviderConfiguration(input);
  const { apiKey: _apiKey, ...rest } = config;
  return structuredClone(rest);
}

function sanitizeModels(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.slice(0, 512).flatMap((item) => {
    const source = record(item);
    const providerID = string(source.providerID);
    const modelID = string(source.modelID) || string(source.id);
    if (!providerID || !modelID) return [];
    const key = `${providerID.toLowerCase()}\u0000${modelID}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const capabilities = record(source.capabilities);
    const api = record(source.api);
    const request = record(source.request);
    return [{
      providerID,
      modelID,
      name: string(source.name) || modelID,
      context: boundedContext(source.context),
      outputLimit: boundedOutput(source.outputLimit ?? source.output),
      enabled: source.enabled !== false,
      status: string(source.status) || 'active',
      capabilities: {
        tools: capabilities.tools === true,
        streaming: capabilities.streaming !== false,
        input: stringArray(capabilities.input).slice(0, 16),
        output: stringArray(capabilities.output).slice(0, 16),
      },
      api: {
        ...(string(api.id) ? { id: string(api.id).slice(0, 240) } : {}),
        ...(string(api.type) ? { type: string(api.type).slice(0, 80) } : {}),
        ...(string(api.package) ? { package: string(api.package).slice(0, 160) } : {}),
      },
      request: {
        headers: sanitizeVariantOptions(record(request.headers)),
        body: sanitizeVariantOptions(record(request.body)),
      },
      variants: sanitizeVariants(source.variants),
    }];
  });
}

function sanitizeVariants(value) {
  if (Array.isArray(value)) return value.slice(0, 64).flatMap((variant) => {
    const item = record(variant); const id = string(item.id);
    if (!id) return [];
    return [{ id: id.slice(0, 80), headers: sanitizeVariantOptions(record(item.headers)), body: sanitizeVariantOptions(record(item.body)) }];
  });
  if (isRecord(value)) return Object.entries(value).slice(0, 64).flatMap(([id, body]) => id && isRecord(body) ? [{ id: id.slice(0, 80), headers: {}, body: sanitizeVariantOptions(body) }] : []);
  return [];
}

function sanitizeVariantBridge(value) {
  const source = record(value);
  const models = Array.isArray(source.models) ? source.models.slice(0, 512).flatMap((entry) => {
    const item = record(entry); const providerID = string(item.providerID); const modelID = string(item.modelID);
    if (!providerID || !modelID) return [];
    return [{ providerID, modelID, variants: sanitizeVariants(item.variants) }];
  }) : [];
  return { schema: 1, models };
}

function sanitizeIntegrations(value, providerID) {
  const items = Array.isArray(value) ? value : [];
  const output = items.slice(0, 256).flatMap((entry) => {
    const item = record(entry); const id = string(item.id);
    return id ? [{ id, name: string(item.name) || id }] : [];
  });
  if (providerID && !output.some((item) => item.id.toLowerCase() === providerID.toLowerCase())) output.unshift({ id: providerID, name: providerID });
  return output;
}

function ensureConfiguredModel(models, selection, metadata) {
  if (!selection?.providerID || !selection.modelID) return;
  if (models.some((model) => sameModel(model, selection))) return;
  const source = record(metadata);
  models.push({
    providerID: selection.providerID,
    modelID: selection.modelID,
    name: string(source.name) || selection.modelID,
    context: boundedContext(source.context),
    outputLimit: boundedOutput(source.outputLimit ?? source.output),
    enabled: true,
    status: 'active',
    capabilities: { tools: true, streaming: true, input: ['text'], output: ['text'] },
    api: {},
    request: { headers: {}, body: {} },
    variants: sanitizeVariants(source.variants),
  });
}

function resolveSelection(selection, models, bridge) {
  if (!selection?.modelID) return null;
  const resolved = resolveLiveModelRef(selection, models);
  if (!resolved) return null;
  const model = findModel(models, resolved);
  if (!modelSupportsCodingAgent(model)) return null;
  if (!selection.variant) return { providerID: resolved.providerID, modelID: resolved.modelID };
  const selected = effortOptions(model, bridge).find((option) => option.toLowerCase() === selection.variant.toLowerCase());
  return selected ? { providerID: resolved.providerID, modelID: resolved.modelID, variant: selected } : { providerID: resolved.providerID, modelID: resolved.modelID };
}

function normalizeRef(value, fallbackProviderID, fallbackModelID, fallbackVariant) {
  const item = record(value);
  const providerID = string(item.providerID) || fallbackProviderID;
  const modelID = string(item.modelID) || fallbackModelID;
  const variant = string(item.variant) || fallbackVariant;
  if (!providerID || !modelID) return null;
  return { providerID, modelID, ...(variant ? { variant } : {}) };
}

function findModel(models, selection) {
  if (!selection) return null;
  return models.find((model) => sameModel(model, selection)) ?? null;
}
function sameModel(left, right) { return string(left?.providerID).toLowerCase() === string(right?.providerID).toLowerCase() && string(left?.modelID) === string(right?.modelID); }
function sameRef(model, selection) { return Boolean(selection && sameModel(model, selection)); }
function normalizeBaseUrl(value) { return value.replace(/\/+$/, '') || DEFAULT_BASE_URL; }
function boundedContext(value) { const number = Number(value); return Number.isFinite(number) ? Math.min(Math.max(Math.trunc(number), 4096), 2_000_000) : DEFAULT_CONTEXT_WINDOW; }
function boundedOutput(value) { const number = Number(value); return Number.isFinite(number) ? Math.min(Math.max(Math.trunc(number), 1), 1_000_000) : 16_384; }
function deepMerge(base, override) {
  const result = structuredClone(sanitizeVariantOptions(record(base)));
  for (const [key, value] of Object.entries(sanitizeVariantOptions(record(override)))) {
    result[key] = isRecord(result[key]) && isRecord(value) ? deepMerge(result[key], value) : structuredClone(value);
  }
  return result;
}
function string(value) { return typeof value === 'string' ? value.trim() : ''; }
function stringArray(value) { return Array.isArray(value) ? value.flatMap((item) => typeof item === 'string' && item.trim() ? [item.trim()] : []) : []; }
function record(value) { return isRecord(value) ? value : {}; }
function isRecord(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }
