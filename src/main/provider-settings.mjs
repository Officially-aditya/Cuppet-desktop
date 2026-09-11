import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { safeStorage } from 'electron';
import { credentialStorageStatus } from './credential-storage.mjs';
import { providerPreset, providerPresetList } from './provider-presets.mjs';
import {
  addCustomModelToRegistry,
  customModelEntries,
  normalizeCustomModelID,
  normalizeCustomModelRegistry,
  probeCustomModel,
} from './custom-models.mjs';
import {
  DEFAULT_BASE_URL,
  DEFAULT_PROVIDER_ID,
  normalizeProviderConfiguration,
  providerProjection,
  resolveAdvertisedSelection,
  serializableProviderConfiguration,
} from '../runtime/provider-policy.mjs';

const DEFAULTS = serializableProviderConfiguration({
  providerID: DEFAULT_PROVIDER_ID,
  baseUrl: DEFAULT_BASE_URL,
  model: '',
  backgroundModel: '',
});

export class ProviderSettingsStore {
  #path;
  #value = structuredClone(DEFAULTS);
  #encryptedApiKey;
  #primaryEffort = '';
  #secondaryAuto = true;
  #customModels = {};

  constructor(path) { this.#path = path; }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.#path, 'utf8'));
      this.#value = serializableProviderConfiguration({ ...DEFAULTS, ...parsed });
      this.#encryptedApiKey = typeof parsed.apiKey === 'string' ? parsed.apiKey : undefined;
      this.#primaryEffort = this.#value.providerID === 'codex' ? effortID(parsed.primaryEffort) : '';
      this.#secondaryAuto = parsed.secondaryAuto !== false;
      this.#customModels = normalizeCustomModelRegistry(parsed.customModels);
    } catch {
      this.#value = structuredClone(DEFAULTS);
      this.#encryptedApiKey = undefined;
      this.#primaryEffort = '';
      this.#secondaryAuto = true;
      this.#customModels = {};
    }
  }

  rendererValue() {
    const effective = this.#effectiveValue();
    const projection = providerProjection(effective, { includeEndpoint: true });
    const storage = credentialStorageStatus(safeStorage);
    const selectedPreset = providerPreset(projection.providerID ?? effective.providerID);
    const chatGPTProvider = selectedPreset?.authType === 'chatgpt';
    const localCliProvider = selectedPreset?.authType === 'local-cli';
    const externalCredentialProvider = chatGPTProvider || localCliProvider;
    const encryptedApiKeyConfigured = Boolean(this.#encryptedApiKey);
    const credentialConfigured = externalCredentialProvider || (storage.available && encryptedApiKeyConfigured);
    return {
      ...projection,
      secondaryAuto: this.#secondaryAuto,
      configured: credentialConfigured && Boolean(projection.primary?.modelID),
      // Compatibility for the current renderer send gate. For Codex this means the provider's
      // credential requirement is satisfied by its separate ChatGPT OAuth flow; no API key exists.
      apiKeyConfigured: externalCredentialProvider ? true : encryptedApiKeyConfigured,
      credentialConfigured,
      credentialMode: selectedPreset?.authType ?? 'api-key',
      authType: selectedPreset?.authType ?? 'api-key',
      requiresChatGPTAuth: chatGPTProvider,
      requiresLocalCli: localCliProvider,
      presetID: selectedPreset?.id ?? null,
      presets: providerPresetList(),
      customModels: customModelEntries(this.#customModels),
      primaryEffort: projection.providerID === 'codex' ? (this.#primaryEffort || null) : (projection.primary?.variant ?? null),
      encryptionAvailable: storage.available,
      encryptionBackend: storage.backend,
      encryptionUnavailableReason: storage.reason,
    };
  }

  runtimeValue() {
    const effective = this.#effectiveValue();
    const selectedPreset = providerPreset(effective.providerID);
    const normalized = normalizeProviderConfiguration({
      ...effective,
      apiKey: ['chatgpt', 'local-cli'].includes(selectedPreset?.authType) ? '' : this.#decryptApiKey(),
    });
    return effective.providerID === 'codex' && this.#primaryEffort
      ? { ...normalized, primaryEffort: this.#primaryEffort }
      : normalized;
  }

  async save(input) {
    const source = input && typeof input === 'object' ? input : {};
    if (Object.prototype.hasOwnProperty.call(source, 'customModel')) return this.#saveCustomModel(source);

    const requestedProviderID = typeof source.providerID === 'string' && source.providerID.trim()
      ? source.providerID.trim()
      : this.#value.providerID || DEFAULT_PROVIDER_ID;
    const preset = providerPreset(requestedProviderID);
    const providerID = preset?.id ?? requestedProviderID;
    const previousProviderID = this.#value.providerID;
    const providerChanged = Boolean(previousProviderID && previousProviderID !== providerID);
    const baseUrl = preset?.baseUrl ?? (typeof source.baseUrl === 'string' ? source.baseUrl.trim() : '');
    const requestedModel = modelID(source.model);
    const requestedBackgroundModel = modelID(source.backgroundModel);
    const currentPrimaryModel = !providerChanged ? modelID(this.#value.primary?.modelID ?? this.#value.model) : '';
    const currentSecondaryModel = !providerChanged ? modelID(this.#value.secondary?.modelID ?? this.#value.backgroundModel) : '';
    // Provider presets own endpoint/auth defaults, but the active model is user-selectable.
    // When the provider itself changes, fall back to that provider's preset model instead of
    // accidentally carrying a model id across providers.
    const model = requestedModel || currentPrimaryModel || modelID(preset?.model);
    const secondaryAutoProvided = Object.prototype.hasOwnProperty.call(source, 'secondaryAuto');
    const secondaryAuto = providerChanged ? true : secondaryAutoProvided ? source.secondaryAuto !== false : this.#secondaryAuto;
    const backgroundModel = secondaryAuto
      ? autoSecondaryModel(preset, model)
      : requestedBackgroundModel || currentSecondaryModel || model;
    const primaryEffort = preset ? '' : (typeof source.primaryEffort === 'string' ? source.primaryEffort.trim() : '');
    const secondaryEffort = secondaryAuto ? '' : preset ? '' : (typeof source.secondaryEffort === 'string' ? source.secondaryEffort.trim() : '');
    const chatGPTProvider = preset?.authType === 'chatgpt';
    const localCliProvider = preset?.authType === 'local-cli';
    const externalCredentialProvider = chatGPTProvider || localCliProvider;
    const codexEffortProvided = providerID === 'codex' && Object.prototype.hasOwnProperty.call(source, 'primaryEffort');
    const codexEffort = providerID === 'codex'
      ? (codexEffortProvided ? effortID(source.primaryEffort) : (!providerChanged ? this.#primaryEffort : ''))
      : '';

    if (!baseUrl) throw new Error('Provider base URL is required');
    if (!externalCredentialProvider) {
      let parsed; try { parsed = new URL(baseUrl); } catch { throw new Error('Provider base URL must be a valid URL'); }
      if (parsed.username || parsed.password) throw new Error('Provider base URL must not contain embedded credentials');
      if (parsed.protocol !== 'https:' && !isLocalhost(parsed.hostname)) throw new Error('Provider base URL must use HTTPS unless it points to localhost');
    }
    if (!model) throw new Error('Primary model is required');

    let next = normalizeProviderConfiguration({
      ...this.#value,
      providerID,
      baseUrl: externalCredentialProvider ? baseUrl : baseUrl.replace(/\/+$/, ''),
      model,
      backgroundModel: backgroundModel || model,
      primary: { providerID, modelID: model },
      secondary: { providerID, modelID: backgroundModel || model },
    });
    if (primaryEffort) next.primary = resolveAdvertisedSelection(next, { ...next.primary, variant: primaryEffort });
    if (secondaryEffort) next.secondary = resolveAdvertisedSelection(next, { ...next.secondary, variant: secondaryEffort });
    next = normalizeProviderConfiguration(next);
    this.#value = serializableProviderConfiguration(next);
    this.#primaryEffort = codexEffort;
    this.#secondaryAuto = secondaryAuto;

    if (externalCredentialProvider || source.clearApiKey === true || (providerChanged && !(typeof source.apiKey === 'string' && source.apiKey.trim()))) {
      this.#encryptedApiKey = undefined;
    } else if (typeof source.apiKey === 'string' && source.apiKey.trim()) {
      const storage = credentialStorageStatus(safeStorage);
      if (!storage.available) throw new Error(`${storage.reason}; Cuppet will not persist the API key in plaintext`);
      this.#encryptedApiKey = safeStorage.encryptString(source.apiKey.trim()).toString('base64');
    }

    await this.#persist();
    return this.rendererValue();
  }

  async #saveCustomModel(source) {
    const activeProviderID = this.#value.providerID || DEFAULT_PROVIDER_ID;
    const requestedProviderID = typeof source.providerID === 'string' && source.providerID.trim() ? source.providerID.trim() : activeProviderID;
    const preset = providerPreset(requestedProviderID);
    const providerID = preset?.id ?? requestedProviderID;
    if (providerID !== activeProviderID) throw new Error('Save this provider first, then add its custom model.');
    if (preset?.authType === 'local-cli') throw new Error('Local CLI providers manage their model catalog inside the CLI.');

    const customModel = normalizeCustomModelID(source.customModel);
    if (preset?.models?.some((item) => item.id === customModel)) throw new Error(`${customModel} is already available in the model picker.`);

    const probe = await probeCustomModel(this.runtimeValue(), customModel);
    this.#customModels = addCustomModelToRegistry(this.#customModels, providerID, customModel);
    await this.#persist();
    return { ...this.rendererValue(), customModelProbe: probe };
  }

  #effectiveValue() {
    if (!this.#secondaryAuto) return this.#value;
    const providerID = this.#value.providerID || DEFAULT_PROVIDER_ID;
    const primaryModel = modelID(this.#value.primary?.modelID ?? this.#value.model);
    if (!primaryModel) return this.#value;
    const secondaryModel = autoSecondaryModel(providerPreset(providerID), primaryModel);
    if (!secondaryModel) return this.#value;
    return serializableProviderConfiguration({
      ...this.#value,
      backgroundModel: secondaryModel,
      secondary: { providerID, modelID: secondaryModel },
    });
  }

  async #persist() {
    await writeSettingsAtomically(this.#path, `${JSON.stringify({
      ...this.#value,
      ...(this.#primaryEffort ? { primaryEffort: this.#primaryEffort } : {}),
      secondaryAuto: this.#secondaryAuto,
      customModels: this.#customModels,
      apiKey: this.#encryptedApiKey,
    }, null, 2)}\n`);
  }

  #decryptApiKey() {
    const storage = credentialStorageStatus(safeStorage);
    if (!this.#encryptedApiKey || !storage.available) return '';
    try { return safeStorage.decryptString(Buffer.from(this.#encryptedApiKey, 'base64')); } catch { return ''; }
  }
}

async function writeSettingsAtomically(path, content) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function autoSecondaryModel(_preset, primaryModel) {
  // Auto means follow provider/user authority exactly; Cuppet never guesses a different model.
  return modelID(primaryModel);
}

function modelID(value) {
  if (typeof value !== 'string') return '';
  const id = value.trim().slice(0, 240);
  if (!id) return '';
  if (/\s|[\u0000-\u001f\u007f]/.test(id)) throw new Error('Model ID contains unsupported characters');
  return id;
}
function effortID(value) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string') throw new Error('Reasoning effort must be a string');
  const id = value.trim().slice(0, 80);
  if (!id) return '';
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('Reasoning effort contains unsupported characters');
  return id;
}
function isLocalhost(hostname) { return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'; }
