import { normalizeProviderCapabilities } from '../../capabilities.mjs';

export function capabilitiesFromAcpSession(session = {}, initialized = {}) {
  const source = record(session);
  const settings = [];
  for (const raw of Array.isArray(source.configOptions) ? source.configOptions : []) {
    const setting = normalizeConfigOption(raw);
    if (setting) settings.push(setting);
  }

  const modelSetting = settings.find((item) => item.category === 'model')
    ?? settings.find((item) => /model/i.test(`${item.id} ${item.label}`));
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
  const options = [];
  const seen = new Set();
  for (const rawOption of Array.isArray(source.options) ? source.options : []) {
    const option = record(rawOption);
    const optionId = text(option.value || option.id);
    if (!optionId || seen.has(optionId)) continue;
    seen.add(optionId);
    options.push({ id: optionId, label: text(option.name || option.label) || optionId, ...(text(option.description) ? { description: text(option.description) } : {}) });
  }
  return { ...base, kind: 'select', ...(text(source.currentValue || source.current_value) ? { value: text(source.currentValue || source.current_value) } : {}), options };
}

function normalizeName(value) { return text(value).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[ -]+/g, '_').toLowerCase(); }
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
