import { createChatProvider } from '../runtime/provider-factory.mjs';
import { normalizeProviderConfiguration } from '../runtime/provider-policy.mjs';

export const CUSTOM_MODEL_PROBE_PROMPT = 'Reply only with OK.';
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_PROVIDERS = 64;
const MAX_MODELS_PER_PROVIDER = 64;

export async function probeCustomModel(configuration, modelID, { providerFactory = createChatProvider, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const id = normalizeCustomModelID(modelID);
  const source = record(configuration);
  const providerID = text(source.providerID) || text(record(source.primary).providerID);
  if (!providerID) throw new Error('Save a provider before adding a custom model.');

  const normalized = normalizeProviderConfiguration({
    ...source,
    providerID,
    model: id,
    backgroundModel: id,
    primary: { providerID, modelID: id },
    secondary: { providerID, modelID: id },
    primaryEffort: '',
    secondaryEffort: '',
  });
  const provider = providerFactory(normalized);
  if (!provider || typeof provider.stream !== 'function') throw new Error('The selected provider cannot validate custom models.');

  const controller = new AbortController();
  let streamed = '';
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Model test timed out after ${Math.ceil(Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS) / 1000)} seconds.`));
    }, Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    timer.unref?.();
  });

  try {
    const result = await Promise.race([
      provider.stream(
        [{ role: 'user', content: CUSTOM_MODEL_PROBE_PROMPT }],
        {
          signal: controller.signal,
          tools: [],
          onDelta: async (delta) => { if (typeof delta === 'string') streamed += delta; },
        },
      ),
      timeout,
    ]);
    const reply = String(result?.text || streamed || '').trim();
    if (!reply) throw new Error('The model returned no text to the validation request.');
    return { ok: true, providerID, modelID: id, reply: reply.slice(0, 120) };
  } catch (error) {
    if (controller.signal.aborted && !/timed out/i.test(cleanError(error))) throw new Error('Model test timed out.');
    throw new Error(`Custom model test failed: ${cleanError(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeCustomModelRegistry(value) {
  const source = record(value);
  const output = {};
  for (const [rawProviderID, rawModels] of Object.entries(source).slice(0, MAX_PROVIDERS)) {
    const providerID = normalizeProviderID(rawProviderID);
    if (!providerID || !Array.isArray(rawModels)) continue;
    const seen = new Set();
    const models = [];
    for (const rawModel of rawModels.slice(0, MAX_MODELS_PER_PROVIDER)) {
      let modelID;
      try { modelID = normalizeCustomModelID(rawModel); } catch { continue; }
      if (seen.has(modelID)) continue;
      seen.add(modelID);
      models.push(modelID);
    }
    if (models.length) output[providerID] = models;
  }
  return output;
}

export function addCustomModelToRegistry(value, providerID, modelID) {
  const registry = normalizeCustomModelRegistry(value);
  const provider = normalizeProviderID(providerID);
  if (!provider) throw new Error('providerID is required');
  const model = normalizeCustomModelID(modelID);
  const current = registry[provider] ?? [];
  if (!current.includes(model)) registry[provider] = [...current, model].slice(-MAX_MODELS_PER_PROVIDER);
  return registry;
}

export function customModelEntries(value) {
  const registry = normalizeCustomModelRegistry(value);
  return Object.entries(registry).flatMap(([providerID, models]) => models.map((modelID) => ({ providerID, modelID })));
}

export function normalizeCustomModelID(value) {
  if (typeof value !== 'string') throw new Error('Custom model ID is required');
  const id = value.trim().slice(0, 240);
  if (!id) throw new Error('Custom model ID is required');
  if (/\s|[\u0000-\u001f\u007f]/.test(id)) throw new Error('Custom model ID contains unsupported whitespace or control characters');
  return id;
}

function normalizeProviderID(value) {
  const id = text(value);
  if (!id || /\s|[\u0000-\u001f\u007f]/.test(id)) return '';
  return id;
}
function cleanError(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    .slice(0, 600);
}
function text(value) { return typeof value === 'string' ? value.trim().slice(0, 240) : ''; }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
