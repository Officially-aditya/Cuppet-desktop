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
  #safeStorage;
  #credentialStorageStatus;
  #value = structuredClone(DEFAULTS);
  #encryptedApiKey;
  #primaryEffort = '';
  #secondaryAuto = true;
  #customModels = {};
  #providerStates = Object.create(null);

  constructor(path, { safeStorageImpl = safeStorage, credentialStorageStatusImpl = credentialStorageStatus } = {}) {
    this.#path = path;
    this.#safeStorage = safeStorageImpl;
    this.#credentialStorageStatus = credentialStorageStatusImpl;
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.#path, 'utf8'));
      this.#value = serializableProviderConfiguration({ ...DEFAULTS, ...parsed });
      this.#encryptedApiKey = typeof parsed.apiKey === 'string' ? parsed.apiKey : undefined;
      this.#primaryEffort = effortID(parsed.primaryEffort);
      this.#secondaryAuto = parsed.secondaryAuto !== false;
      this.#customModels = normalizeCustomModelRegistry(parsed.customModels);
      this.#providerStates = Object.create(null);
      const states = parsed.providerStates && typeof parsed.providerStates === 'object' && !Array.isArray(parsed.providerStates)
        ? parsed.providerStates : {};
      for (const [providerID, state] of Object.entries(states)) {
        if (!state || typeof state !== 'object' || Array.isArray(state)) continue;
        this.#providerStates[providerID] = {
          ...serializableProviderConfiguration({ ...state, providerID }),
          primaryEffort: effortID(state.primaryEffort),
          secondaryAuto: state.secondaryAuto !== false,
        };
      }
      // Seed the active state when loading settings written before per-provider persistence.
      this.#providerStates[this.#value.providerID] = {
        ...this.#value, primaryEffort: this.#primaryEffort, secondaryAuto: this.#secondaryAuto,
      };
    } catch {
      this.#value = structuredClone(DEFAULTS);
      this.#encryptedApiKey = undefined;
      this.#primaryEffort = '';
      this.#secondaryAuto = true;
      this.#customModels = {};
      this.#providerStates = Object.create(null);
    }
  }

  rendererValue() {
    const effective = this.#effectiveValue();
    const projection = providerProjection(effective, { includeEndpoint: true });
    const selectedPreset = providerPreset(projection.providerID ?? effective.providerID);
    const chatGPTProvider = selectedPreset?.authType === 'chatgpt';
    const localCliProvider = selectedPreset?.authType === 'local-cli';
    const externalCredentialProvider = chatGPTProvider || localCliProvider;
    // Provider-managed auth must not touch Electron safeStorage/Keychain merely to
    // render Settings. Only API-key providers need the host credential vault.
    const storage = externalCredentialProvider ? null : this.#credentialStorageStatus(this.#safeStorage);
    const encryptedApiKeyConfigured = Boolean(this.#encryptedApiKey);
    const credentialConfigured = externalCredentialProvider || Boolean(storage?.available && encryptedApiKeyConfigured);
    return {
      ...projection,
      secondaryAuto: this.#secondaryAuto,
      configured: credentialConfigured && Boolean(projection.primary?.modelID),
      // Compatibility for the current renderer send gate. For Codex/local CLI this means
      // the credential requirement is provider-managed; no Cuppet API key exists.
      apiKeyConfigured: externalCredentialProvider ? true : encryptedApiKeyConfigured,
      credentialConfigured,
      credentialMode: selectedPreset?.authType ?? 'api-key',
      authType: selectedPreset?.authType ?? 'api-key',
      requiresChatGPTAuth: chatGPTProvider,
      requiresLocalCli: localCliProvider,
      presetID: selectedPreset?.id ?? null,
      presets: providerPresetList(),
      customModels: customModelEntries(this.#customModels),
      primaryEffort: this.#primaryEffort || projection.primary?.variant || null,
      encryptionAvailable: externalCredentialProvider ? true : storage?.available === true,
      encryptionBackend: externalCredentialProvider ? 'provider-managed' : storage?.backend,
      encryptionUnavailableReason: externalCredentialProvider ? undefined : storage?.reason,
    };
  }

  runtimeValue() {
    const effective = this.#effectiveValue();
    const selectedPreset = providerPreset(effective.providerID);
    const normalized = normalizeProviderConfiguration({
      ...effective,
      apiKey: ['chatgpt', 'local-cli'].includes(selectedPreset?.authType) ? '' : this.#decryptApiKey(),
    });
    return this.#primaryEffort ? { ...normalized, primaryEffort: this.#primaryEffort } : normalized;
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
    const savedState = providerChanged ? this.#providerStates[providerID] : {
      ...this.#value, primaryEffort: this.#primaryEffort, secondaryAuto: this.#secondaryAuto,
    };
    const current = savedState ?? DEFAULTS;
    const baseUrl = preset?.baseUrl ?? (typeof source.baseUrl === 'string' ? source.baseUrl.trim() : savedState?.baseUrl || '');
    const requestedModel = modelID(source.model);
    const requestedBackgroundModel = modelID(source.backgroundModel);
    const currentPrimaryModel = modelID(current.primary?.modelID ?? current.model);
    const currentSecondaryModel = modelID(current.secondary?.modelID ?? current.backgroundModel);
    // Reuse this provider's choices; presets supply defaults only on its first selection.
    const model = requestedModel || currentPrimaryModel || modelID(preset?.model);
    const secondaryAutoProvided = Object.prototype.hasOwnProperty.call(source, 'secondaryAuto');
    const secondaryAuto = secondaryAutoProvided ? source.secondaryAuto !== false : savedState?.secondaryAuto !== false;
    const backgroundModel = secondaryAuto
      ? autoSecondaryModel(preset, model)
      : requestedBackgroundModel || currentSecondaryModel || model;
    const chatGPTProvider = preset?.authType === 'chatgpt';
    const localCliProvider = preset?.authType === 'local-cli';
    const externalCredentialProvider = chatGPTProvider || localCliProvider;
    const persistentEffortProvider = providerID === 'codex' || localCliProvider;
    const primaryEffortProvided = Object.prototype.hasOwnProperty.call(source, 'primaryEffort');
    const persistedPrimaryEffort = persistentEffortProvider
      ? (primaryEffortProvided ? effortID(source.primaryEffort) : savedState?.primaryEffort || '')
      : '';
    const primaryEffort = preset ? '' : primaryEffortProvided
      ? effortID(source.primaryEffort) : model === currentPrimaryModel ? current.primary?.variant || '' : '';
    const secondaryEffortProvided = Object.prototype.hasOwnProperty.call(source, 'secondaryEffort');
    const secondaryEffort = secondaryAuto || preset ? '' : secondaryEffortProvided
      ? effortID(source.secondaryEffort) : backgroundModel === currentSecondaryModel ? current.secondary?.variant || '' : '';

    if (!baseUrl) throw new Error('Provider base URL is required');
    if (!externalCredentialProvider) {
      let parsed; try { parsed = new URL(baseUrl); } catch { throw new Error('Provider base URL must be a valid URL'); }
      if (parsed.username || parsed.password) throw new Error('Provider base URL must not contain embedded credentials');
      if (parsed.protocol !== 'https:' && !isLocalhost(parsed.hostname)) throw new Error('Provider base URL must use HTTPS unless it points to localhost');
    }
    if (!model) throw new Error('Primary model is required');

    let next = normalizeProviderConfiguration({
      ...current,
      primaryEffort: '',
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
    this.#primaryEffort = persistedPrimaryEffort;
    this.#secondaryAuto = secondaryAuto;

    if (externalCredentialProvider || source.clearApiKey === true || (providerChanged && !(typeof source.apiKey === 'string' && source.apiKey.trim()))) {
      this.#encryptedApiKey = undefined;
    } else if (typeof source.apiKey === 'string' && source.apiKey.trim()) {
      const storage = this.#credentialStorageStatus(this.#safeStorage);
      if (!storage.available) throw new Error(`${storage.reason}; Cuppet will not persist the API key in plaintext`);
      this.#encryptedApiKey = this.#safeStorage.encryptString(source.apiKey.trim()).toString('base64');
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
    this.#providerStates[this.#value.providerID] = {
      ...this.#value, primaryEffort: this.#primaryEffort, secondaryAuto: this.#secondaryAuto,
    };
    await writeSettingsAtomically(this.#path, `${JSON.stringify({
      ...this.#value,
      ...(this.#primaryEffort ? { primaryEffort: this.#primaryEffort } : {}),
      secondaryAuto: this.#secondaryAuto,
      customModels: this.#customModels,
      providerStates: this.#providerStates,
      apiKey: this.#encryptedApiKey,
    }, null, 2)}\n`);
  }

  #decryptApiKey() {
    if (!this.#encryptedApiKey) return '';
    const storage = this.#credentialStorageStatus(this.#safeStorage);
    if (!storage.available) return '';
    try { return this.#safeStorage.decryptString(Buffer.from(this.#encryptedApiKey, 'base64')); } catch { return ''; }
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
