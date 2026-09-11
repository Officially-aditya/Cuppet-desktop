export function emptyProviderCapabilities() {
  return Object.freeze({
    models: Object.freeze([]),
    settings: Object.freeze([]),
    attachments: Object.freeze({ image: false, text: false, pdf: false, audio: false }),
    sessions: Object.freeze({ resume: false, cancel: false }),
    tools: Object.freeze({ hostFilesystem: false, hostTerminal: false, permissions: false }),
  });
}

export function normalizeProviderCapabilities(input = {}) {
  const source = record(input);
  const models = uniqueById(source.models, normalizeModel);
  const settings = uniqueById(source.settings, normalizeRuntimeSetting);

  return Object.freeze({
    models: Object.freeze(models),
    settings: Object.freeze(settings),
    attachments: Object.freeze(flagGroup(source.attachments, ['image', 'text', 'pdf', 'audio'])),
    sessions: Object.freeze(flagGroup(source.sessions, ['resume', 'cancel'])),
    tools: Object.freeze(flagGroup(source.tools, ['hostFilesystem', 'hostTerminal', 'permissions'])),
  });
}

export function findRuntimeSetting(capabilities, selector = {}) {
  const source = record(selector);
  const settings = Array.isArray(capabilities?.settings) ? capabilities.settings : [];
  const requestedId = text(source.id);
  const requestedCategory = text(source.category);
  if (requestedId) {
    const exact = settings.find((setting) => setting.id === requestedId);
    if (exact) return exact;
  }
  if (requestedCategory) return settings.find((setting) => setting.category === requestedCategory) ?? null;
  return null;
}

export function modelRuntimeSetting(capabilities) {
  return findRuntimeSetting(capabilities, { category: 'model' })
    ?? findRuntimeSetting(capabilities, { id: 'model' });
}

export function reasoningRuntimeSetting(capabilities) {
  const settings = Array.isArray(capabilities?.settings) ? capabilities.settings : [];
  return settings.find((setting) => setting.category === 'thought_level')
    ?? settings.find((setting) => /(?:reason|thought|effort)/i.test(`${setting.id} ${setting.label}`))
    ?? null;
}

export function settingAdvertisesValue(setting, value) {
  if (!setting) return false;
  if (setting.kind === 'boolean') return typeof value === 'boolean';
  if (setting.kind !== 'select' || typeof value !== 'string') return false;
  return setting.options.some((option) => option.id === value);
}

function normalizeModel(raw) {
  const source = record(raw);
  const id = text(source.id);
  if (!id) return null;
  return Object.freeze({
    id,
    label: text(source.label) || id,
    ...(text(source.description) ? { description: text(source.description) } : {}),
    ...(source.isDefault === true ? { isDefault: true } : {}),
  });
}

function normalizeRuntimeSetting(raw) {
  const source = record(raw);
  const id = text(source.id);
  if (!id) return null;
  const kind = source.kind === 'boolean' ? 'boolean' : source.kind === 'select' ? 'select' : null;
  if (!kind) return null;
  const base = {
    id,
    kind,
    label: text(source.label) || id,
    ...(text(source.category) ? { category: text(source.category) } : {}),
    ...(text(source.description) ? { description: text(source.description) } : {}),
  };
  if (kind === 'boolean') {
    return Object.freeze({ ...base, value: source.value === true });
  }
  return Object.freeze({
    ...base,
    ...(typeof source.value === 'string' ? { value: source.value } : {}),
    options: Object.freeze(uniqueById(source.options, normalizeSettingOption)),
  });
}

function normalizeSettingOption(raw) {
  const source = record(raw);
  const id = text(source.id);
  if (!id) return null;
  return Object.freeze({
    id,
    label: text(source.label) || id,
    ...(text(source.description) ? { description: text(source.description) } : {}),
  });
}

function uniqueById(value, normalize) {
  const result = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    const item = normalize(raw);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

function flagGroup(value, keys) {
  const source = record(value);
  return Object.fromEntries(keys.map((key) => [key, source[key] === true]));
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
