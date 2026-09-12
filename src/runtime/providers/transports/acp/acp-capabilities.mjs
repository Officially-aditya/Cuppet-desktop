import { normalizeProviderCapabilities } from '../../capabilities.mjs';

export function capabilitiesFromAcpSession(session = {}, initialized = {}) {
  const source = record(session);
  const settings = [];
  const rawOptions = [
    ...(Array.isArray(source.configOptions) ? source.configOptions : []),
    ...(Array.isArray(source._cuppetConfigOptions) ? source._cuppetConfigOptions : []),
  ];
  for (const raw of rawOptions) {
    const setting = normalizeConfigOption(raw);
    if (setting) settings.push(setting);
  }

  let modelSetting = settings.find((item) => item.category === 'model')
    ?? settings.find((item) => /model/i.test(`${item.id} ${item.label}`));
  if (!modelSetting) {
    const legacyModelSetting = legacyModelConfigOption(source);
    if (legacyModelSetting) {
      settings.push(legacyModelSetting);
      modelSetting = legacyModelSetting;
    }
  }

  const models = modelSetting?.kind === 'select'
    ? modelSetting.options.map((item) => ({ id: item.id, label: item.label, ...(item.description ? { description: item.description } : {}) }))
    : [];

  const agentCapabilities = record(initialized.agentCapabilities);
  return normalizeProviderCapabilities({
    models,
    settings,
    attachments: { text: true },
    sessions: { cancel: true, resume: Boolean(agentCapabilities.loadSession || agentCapabilities.sessionLoad) },
    tools: { hostFilesystem: true, hostTerminal: true, permissions: true },
  });
}

export function withAcpConfigOptions(session, result) {
  return Array.isArray(result?.configOptions) ? { ...record(session), configOptions: result.configOptions } : session;
}

export function withAcpCompatConfigOption(session, option) {
  const source = record(session);
  const incoming = record(option);
  const id = text(incoming.id);
  if (!id) return session;
  const current = Array.isArray(source._cuppetConfigOptions) ? source._cuppetConfigOptions : [];
  const next = current.filter((item) => text(record(item).id) !== id);
  next.push(incoming);
  return { ...source, _cuppetConfigOptions: next };
}

export function hasNativeAcpConfigOption(session, settingId) {
  const requested = text(settingId);
  return Boolean(requested && (Array.isArray(record(session).configOptions) ? record(session).configOptions : [])
    .some((raw) => text(record(raw).id) === requested));
}

export function legacyAcpAdvertisesModel(session, modelId) {
  const requested = text(modelId);
  return Boolean(requested && legacyModelOptions(record(session)).some((item) => item.id === requested));
}

export function withLegacyAcpModel(session, modelId) {
  const source = record(session);
  const models = record(source.models);
  const requested = text(modelId);
  if (!requested || !legacyAcpAdvertisesModel(source, requested)) return session;
  return {
    ...source,
    models: {
      ...models,
      currentModelId: requested,
      ...(Object.prototype.hasOwnProperty.call(models, 'current_model_id') ? { current_model_id: requested } : {}),
    },
  };
}

function legacyModelConfigOption(session) {
  const options = legacyModelOptions(session);
  if (!options.length) return null;
  const models = record(record(session).models);
  const current = text(models.currentModelId || models.current_model_id || models.currentModel || models.current_model);
  return {
    id: 'model',
    label: 'Model',
    category: 'model',
    kind: 'select',
    ...(current ? { value: current } : {}),
    options,
  };
}

function legacyModelOptions(session) {
  const models = record(record(session).models);
  const available = Array.isArray(models.availableModels)
    ? models.availableModels
    : Array.isArray(models.available_models)
      ? models.available_models
      : Array.isArray(models.models)
        ? models.models
        : [];
  const options = [];
  const seen = new Set();
  for (const raw of available) {
    const item = record(raw);
    const id = text(item.modelId || item.modelID || item.id || item.value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    options.push({
      id,
      label: text(item.name || item.label || item.displayName || item.display_name) || id,
      ...(text(item.description) ? { description: text(item.description) } : {}),
    });
  }
  return options;
}

function normalizeConfigOption(raw) {
  const source = record(raw);
  const id = text(source.id);
  if (!id) return null;
  const category = normalizeName(source.category);
  const base = {
    id,
    label: text(source.name || source.label) || id,
    ...(category ? { category } : {}),
    ...(text(source.description) ? { description: text(source.description) } : {}),
  };
  if (source.type === 'boolean') return { ...base, kind: 'boolean', value: source.currentValue === true || source.current_value === true };
  if (source.type !== 'select') return null;
  const options = flattenSelectOptions(source.options);
  return { ...base, kind: 'select', ...(text(source.currentValue || source.current_value) ? { value: text(source.currentValue || source.current_value) } : {}), options };
}

function flattenSelectOptions(value) {
  const options = [];
  const seen = new Set();
  const visit = (raw) => {
    const option = record(raw);
    if (Array.isArray(option.options)) {
      for (const child of option.options) visit(child);
      return;
    }
    const optionId = text(option.value || option.id);
    if (!optionId || seen.has(optionId)) return;
    seen.add(optionId);
    options.push({
      id: optionId,
      label: text(option.name || option.label) || optionId,
      ...(text(option.description) ? { description: text(option.description) } : {}),
    });
  };
  for (const raw of Array.isArray(value) ? value : []) visit(raw);
  return options;
}

function normalizeName(value) { return text(value).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[ -]+/g, '_').toLowerCase(); }
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
