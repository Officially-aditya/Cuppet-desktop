import { spawn } from 'node:child_process';
import { discoverAcpRuntimeCatalog } from '../runtime/providers/transports/acp/acp-discovery.mjs';
import { localCliDescriptor } from '../runtime/local-cli-descriptors.mjs';

const ANTHROPIC_VERSION = '2023-06-01';
const FETCH_TIMEOUT_MS = 10_000;
const CLI_TIMEOUT_MS = 10_000;

/**
 * Ask the active provider for the models it actually advertises to this account.
 * No model is invented here: ordering and ids come from the provider/CLI response.
 *
 * options.model is a read-only candidate selection. It lets callers refresh
 * model-dependent provider settings before persisting that model in Cuppet.
 */
export async function fetchProviderModelCatalog(configuration = {}, options = {}) {
  const providerID = text(configuration.providerID || configuration.primary?.providerID).toLowerCase();
  const requestedModel = text(options.model);
  const configuredModel = requestedModel || text(configuration.primary?.modelID || configuration.model);
  const discoveryConfiguration = requestedModel ? configurationForCandidateModel(configuration, requestedModel) : configuration;
  if (!providerID) return unavailable('', 'none', 'No active provider is configured.');

  if (providerID === 'codex') {
    try {
      let discover = typeof options.codexDiscover === 'function' ? options.codexDiscover : null;
      if (!discover) {
        const host = await import('./codex-auth.mjs');
        discover = host.listCodexModels;
      }
      if (typeof discover !== 'function') return unavailable(providerID, 'codex', 'Codex model discovery is unavailable in this host.');
      return catalogFromCodexModels(await discover(), configuredModel);
    } catch (error) {
      return unavailable(providerID, 'codex', cleanError(error));
    }
  }

  const descriptor = localCliDescriptor(providerID);
  if (descriptor) {
    if (descriptor.transport === 'acp') {
      try {
        const discover = typeof options.acpDiscover === 'function' ? options.acpDiscover : discoverAcpRuntimeCatalog;
        const catalog = await discover(providerID, { configuration: discoveryConfiguration });
        return normalizeCatalog(providerID, 'acp', catalog, configuredModel);
      } catch (error) {
        return unavailable(providerID, 'acp', cleanError(error));
      }
    }
    if (descriptor.id === 'antigravity') {
      try {
        const discover = typeof options.cliDiscover === 'function' ? options.cliDiscover : discoverAntigravityModels;
        const catalog = await discover(descriptor);
        return normalizeCatalog(providerID, 'cli', catalog, configuredModel);
      } catch (error) {
        return unavailable(providerID, 'cli', cleanError(error));
      }
    }
    return unavailable(providerID, 'cli', `${descriptor.label} does not advertise a model catalog through its current transport.`);
  }

  const apiKey = text(configuration.apiKey);
  if (!apiKey) return unavailable(providerID, 'api', 'Save this provider credential before loading its advertised models.');
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') return unavailable(providerID, 'api', 'Model discovery fetch is unavailable.');

  try {
    const request = apiCatalogRequest(providerID, configuration.baseUrl, apiKey);
    const payload = await requestJson(fetchImpl, request.url, request.headers);
    const parsed = parseApiCatalog(providerID, payload);
    return normalizeCatalog(providerID, 'api', parsed, configuredModel);
  } catch (error) {
    return unavailable(providerID, 'api', cleanError(error));
  }
}

export function catalogFromCodexModels(catalog = {}, configuredModel = '') {
  const input = record(catalog);
  const rawModels = array(input.models);
  const models = [];
  const sourceById = new Map();
  const seen = new Set();
  for (const raw of rawModels) {
    const item = record(raw);
    const id = text(item.id || item.model);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    sourceById.set(id, item);
    models.push({
      id,
      label: text(item.label || item.displayName) || id,
      ...(text(item.description) ? { description: text(item.description) } : {}),
      ...(item.isDefault === true ? { isDefault: true } : {}),
    });
  }

  const declaredDefault = text(input.defaultModel);
  const rowDefault = models.find((item) => item.isDefault)?.id || '';
  const defaultModel = models.some((item) => item.id === declaredDefault) ? declaredDefault : rowDefault || null;
  const configured = text(configuredModel);
  const effectiveModel = configured === 'codex-default' ? defaultModel : configured;
  const selected = effectiveModel ? sourceById.get(effectiveModel) : null;
  const efforts = [];
  const effortSeen = new Set();
  for (const raw of array(selected?.efforts ?? selected?.supportedReasoningEfforts)) {
    const value = typeof raw === 'string' ? raw : record(raw).reasoningEffort ?? record(raw).id;
    const id = text(value);
    if (!id || effortSeen.has(id)) continue;
    effortSeen.add(id);
    efforts.push({ id, label: id });
  }
  const declaredEffort = text(selected?.defaultEffort ?? selected?.defaultReasoningEffort);
  const defaultEffort = efforts.some((item) => item.id === declaredEffort) ? declaredEffort : null;
  const reasoning = efforts.length ? {
    configId: 'model_reasoning_effort',
    currentValue: defaultEffort,
    options: efforts,
  } : null;

  return {
    providerID: 'codex',
    available: input.available !== false && models.length > 0,
    source: 'codex',
    modelDependentSettings: true,
    models,
    defaultModel,
    configuredModel: configured || null,
    fetchedAt: Date.now(),
    ...(reasoning ? { reasoning } : {}),
    ...(text(input.error) ? { error: text(input.error) } : {}),
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
  return { models, defaultModel: declaredDefault || rowDefault || null };
}

export async function discoverAntigravityModels(descriptor, { commandOverride = '', runImpl = runCommand } = {}) {
  const command = text(commandOverride) || text(process.env[descriptor.envOverride]) || descriptor.command;
  const { stdout } = await runImpl(command, ['models'], CLI_TIMEOUT_MS);
  const models = parseAntigravityModelOutput(stdout);
  return { available: models.length > 0, models, defaultModel: null };
}

export function parseAntigravityModelOutput(output = '') {
  const models = [];
  const seen = new Set();
  for (const rawLine of String(output ?? '').split(/\r?\n/)) {
    const line = stripAnsi(rawLine).trim();
    if (!line) continue;

    let id = '';
    let label = '';
    const tab = line.indexOf('\t');
    if (tab > 0) {
      id = text(line.slice(0, tab));
      label = text(line.slice(tab + 1)) || id;
    } else {
      const columns = line.match(/^([^\s]+)\s{2,}(.+)$/);
      if (columns) {
        id = text(columns[1]);
        label = text(columns[2]) || id;
      } else if (/^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]*$/.test(line)) {
        id = text(line);
        label = id;
      } else {
        continue;
      }
    }

    if (!id || seen.has(id) || /^(model|models|slug)$/i.test(id)) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]*$/.test(id)) continue;
    seen.add(id);
    models.push({ id, label });
    if (models.length >= 512) break;
  }
  return models;
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

function normalizeCatalog(providerID, source, catalog, configuredModel) {
  const input = record(catalog);
  const models = [];
  const seen = new Set();
  for (const raw of array(input.models)) {
    const item = record(raw);
    const id = text(item.id || item.value || item.modelID);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      label: text(item.label || item.name) || id,
      ...(text(item.description) ? { description: text(item.description) } : {}),
      ...(positiveInt(item.context) ? { context: positiveInt(item.context) } : {}),
      ...(positiveInt(item.outputLimit) ? { outputLimit: positiveInt(item.outputLimit) } : {}),
      ...(item.isDefault === true ? { isDefault: true } : {}),
    });
  }
  const declaredDefault = text(input.defaultModel || input.currentModel || input.currentValue);
  const exactDefault = declaredDefault && models.some((item) => item.id === declaredDefault) ? declaredDefault : null;
  const configured = text(configuredModel);
  const reasoningSource = record(input.reasoning);
  const reasoningOptions = array(reasoningSource.options).flatMap((raw) => {
    const item = record(raw);
    const id = text(item.id || item.value);
    return id ? [{ id, label: text(item.label || item.name) || id, ...(text(item.description) ? { description: text(item.description) } : {}) }] : [];
  });
  const reasoningConfigId = text(reasoningSource.configId || reasoningSource.id);
  const reasoning = reasoningConfigId && reasoningOptions.length ? {
    configId: reasoningConfigId,
    currentValue: text(reasoningSource.currentValue) || null,
    options: reasoningOptions,
  } : null;
  return {
    providerID,
    available: models.length > 0,
    source,
    ...(source === 'acp' ? { modelDependentSettings: true } : {}),
    models,
    defaultModel: exactDefault,
    configuredModel: configured || null,
    fetchedAt: Date.now(),
    ...(reasoning ? { reasoning } : {}),
    ...(text(input.error) ? { error: text(input.error) } : {}),
  };
}

function unavailable(providerID, source, error) {
  return { providerID, available: false, source, models: [], defaultModel: null, configuredModel: null, fetchedAt: Date.now(), ...(error ? { error } : {}) };
}

function configurationForCandidateModel(configuration, modelID) {
  const source = { ...record(configuration), model: modelID, primaryEffort: '' };
  delete source.effort;
  const primary = { ...record(source.primary), modelID };
  delete primary.variant;
  source.primary = primary;
  return source;
}

function runCommand(command, args, timeoutMs) {
  return new Promise((resolveRun, rejectRun) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false, env: { ...process.env } });
    } catch (error) { rejectRun(error); return; }
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      rejectRun(new Error(`${command} timed out while advertising models.`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout = `${stdout}${String(chunk)}`.slice(-512_000); });
    child.stderr?.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-64_000); });
    child.once('error', (error) => { clearTimeout(timer); rejectRun(error); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolveRun({ stdout, stderr });
      else rejectRun(new Error((stderr || stdout || `${command} exited with code ${code}`).trim().slice(-1200)));
    });
  });
}

function explicitDefault(item) { return item?.is_default === true || item?.isDefault === true || item?.default === true; }
function firstArray(...values) { return values.find(Array.isArray) ?? []; }
function positiveInt(value) { const number = Number(value); return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0; }
function stripSlash(value) { return value.replace(/\/+$/, ''); }
function stripAnsi(value) { return String(value ?? '').replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, ''); }
function cleanError(error) { return String(error instanceof Error ? error.message : error ?? '').replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]').slice(0, 1000); }
function text(value) { return typeof value === 'string' ? value.trim().slice(0, 1000) : ''; }
function array(value) { return Array.isArray(value) ? value : []; }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }