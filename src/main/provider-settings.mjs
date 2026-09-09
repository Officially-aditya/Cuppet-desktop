import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { safeStorage } from 'electron';
import { credentialStorageStatus } from './credential-storage.mjs';
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
    const projection = providerProjection(this.#value, { includeEndpoint: true });
    const storage = credentialStorageStatus(safeStorage);
    const apiKeyConfigured = Boolean(this.#encryptedApiKey);
    return {
      ...projection,
      configured: storage.available && apiKeyConfigured && Boolean(projection.primary?.modelID),
      apiKeyConfigured,
      encryptionAvailable: storage.available,
      encryptionBackend: storage.backend,
      encryptionUnavailableReason: storage.reason,
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
      const storage = credentialStorageStatus(safeStorage);
      if (!storage.available) throw new Error(`${storage.reason}; Cuppet will not persist the API key in plaintext`);
      this.#encryptedApiKey = safeStorage.encryptString(source.apiKey.trim()).toString('base64');
    }

    await writeSettingsAtomically(this.#path, `${JSON.stringify({ ...this.#value, apiKey: this.#encryptedApiKey }, null, 2)}\n`);
    return this.rendererValue();
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

function isLocalhost(hostname) { return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'; }
