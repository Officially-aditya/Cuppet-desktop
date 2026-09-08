import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { safeStorage } from 'electron';
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

  constructor(path) { this.#path = path; }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.#path, 'utf8'));
      this.#value = serializableProviderConfiguration({ ...DEFAULTS, ...parsed });
      this.#encryptedApiKey = typeof parsed.apiKey === 'string' ? parsed.apiKey : undefined;
    } catch {
      this.#value = structuredClone(DEFAULTS);
      this.#encryptedApiKey = undefined;
    }
  }

  rendererValue() {
    return {
      ...providerProjection(this.#value, { includeEndpoint: true }),
      apiKeyConfigured: Boolean(this.#encryptedApiKey),
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
    };
  }

  runtimeValue() {
    return normalizeProviderConfiguration({ ...this.#value, apiKey: this.#decryptApiKey() });
  }

  async save(input) {
    const source = input && typeof input === 'object' ? input : {};
    const baseUrl = typeof source.baseUrl === 'string' ? source.baseUrl.trim() : '';
    const providerID = typeof source.providerID === 'string' && source.providerID.trim() ? source.providerID.trim() : this.#value.providerID || DEFAULT_PROVIDER_ID;
    const model = typeof source.model === 'string' ? source.model.trim() : '';
    const backgroundModel = typeof source.backgroundModel === 'string' ? source.backgroundModel.trim() : '';
    const primaryEffort = typeof source.primaryEffort === 'string' ? source.primaryEffort.trim() : '';
    const secondaryEffort = typeof source.secondaryEffort === 'string' ? source.secondaryEffort.trim() : '';
    if (!baseUrl) throw new Error('Provider base URL is required');
    let parsed; try { parsed = new URL(baseUrl); } catch { throw new Error('Provider base URL must be a valid URL'); }
    if (parsed.username || parsed.password) throw new Error('Provider base URL must not contain embedded credentials');
    if (parsed.protocol !== 'https:' && !isLocalhost(parsed.hostname)) throw new Error('Provider base URL must use HTTPS unless it points to localhost');
    if (!model) throw new Error('Primary model is required');

    let next = normalizeProviderConfiguration({
      ...this.#value,
      providerID,
      baseUrl: baseUrl.replace(/\/+$/, ''),
      model,
      backgroundModel: backgroundModel || model,
      primary: { providerID, modelID: model },
      secondary: { providerID, modelID: backgroundModel || model },
    });
    if (primaryEffort) next.primary = resolveAdvertisedSelection(next, { ...next.primary, variant: primaryEffort });
    if (secondaryEffort) next.secondary = resolveAdvertisedSelection(next, { ...next.secondary, variant: secondaryEffort });
    next = normalizeProviderConfiguration(next);
    this.#value = serializableProviderConfiguration(next);

    if (source.clearApiKey === true) this.#encryptedApiKey = undefined;
    else if (typeof source.apiKey === 'string' && source.apiKey.trim()) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('OS credential encryption is unavailable; Cuppet will not persist the API key in plaintext');
      this.#encryptedApiKey = safeStorage.encryptString(source.apiKey.trim()).toString('base64');
    }

    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(this.#path, `${JSON.stringify({ ...this.#value, apiKey: this.#encryptedApiKey }, null, 2)}\n`, { mode: 0o600 });
    return this.rendererValue();
  }

  #decryptApiKey() {
    if (!this.#encryptedApiKey || !safeStorage.isEncryptionAvailable()) return '';
    try { return safeStorage.decryptString(Buffer.from(this.#encryptedApiKey, 'base64')); } catch { return ''; }
  }
}

function isLocalhost(hostname) { return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'; }
