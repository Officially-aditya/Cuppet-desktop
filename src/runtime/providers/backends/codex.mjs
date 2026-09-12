import { CodexAppServerClient, resolveCodexAppServerCommand } from '../../codex-app-server.mjs';
import { parseCodexAccount } from '../../codex-account.mjs';
import { CodexSubscriptionProvider } from '../../codex-provider.mjs';

const MAX_CODEX_MODELS = 256;

export function codexBackendDefinition() {
  return {
    id: 'codex',
    label: 'Codex',
    transport: 'app-server',
    operations: {
      discoverCapabilities: async ({ configuration = {}, options = {} } = {}) => {
        const discover = typeof options.codexDiscover === 'function' ? options.codexDiscover : listCodexModels;
        const raw = await discover({
          resourcesPath: options.resourcesPath ?? configuration.resourcesPath,
          env: options.env ?? process.env,
        });
        return catalogFromCodexModels(raw, text(configuration.primary?.modelID || configuration.model));
      },
    },
    createRuntime: ({ configuration = {} } = {}) => new CodexSubscriptionProvider(configuration),
  };
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
    settings: reasoning ? [{ id: reasoning.configId, kind: 'select', category: 'thought_level', label: 'Reasoning effort', value: reasoning.currentValue ?? undefined, options: reasoning.options }] : [],
    defaultModel,
    currentModel: effectiveModel || null,
    configuredModel: configured || null,
    fetchedAt: Date.now(),
    ...(reasoning ? { reasoning } : {}),
    ...(text(input.error) ? { error: text(input.error) } : {}),
  };
}

export async function listCodexModels({ resourcesPath = process.env.CUPPET_RESOURCES_PATH, env = process.env } = {}) {
  const launch = await resolveCodexAppServerCommand({ resourcesPath, env });
  if (!launch) return { available: false, loggedIn: false, models: [], defaultModel: null };
  const client = new CodexAppServerClient({ ...launch, env });
  try {
    await client.start();
    const account = parseCodexAccount(await client.request('account/read', {}));
    if (!account.loggedIn) return { available: true, loggedIn: false, models: [], defaultModel: null };

    const models = [];
    let cursor = null;
    do {
      const response = record(await client.request('model/list', { cursor, limit: 100, includeHidden: false }));
      for (const entry of array(response.data)) {
        const item = record(entry);
        if (item.hidden === true) continue;
        const id = safeText(item.model ?? item.id, 240);
        if (!id) continue;
        const efforts = array(item.supportedReasoningEfforts).flatMap((value) => {
          const effort = safeText(record(value).reasoningEffort, 80);
          return effort ? [effort] : [];
        });
        models.push({
          id,
          label: safeText(item.displayName ?? item.id ?? id, 160) || id,
          description: safeText(item.description, 600),
          isDefault: item.isDefault === true,
          efforts,
          defaultEffort: safeText(item.defaultReasoningEffort, 80) || null,
        });
        if (models.length >= MAX_CODEX_MODELS) break;
      }
      cursor = models.length < MAX_CODEX_MODELS ? safeText(response.nextCursor, 512) || null : null;
    } while (cursor);

    const deduped = [...new Map(models.map((model) => [model.id, model])).values()];
    return { available: true, loggedIn: true, models: deduped, defaultModel: deduped.find((model) => model.isDefault)?.id ?? null };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function safeText(value, max) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function text(value) { return typeof value === 'string' ? value.trim().slice(0, 1000) : ''; }
function array(value) { return Array.isArray(value) ? value : []; }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
