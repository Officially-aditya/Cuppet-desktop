import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { safeStorage } from 'electron';

const DEFAULTS = {
  provider: 'openai-compatible',
  baseUrl: 'https://api.openai.com/v1',
  model: '',
};

export class ProviderSettingsStore {
  #path;
  #value = { ...DEFAULTS };
  #encryptedApiKey;

  constructor(path) {
    this.#path = path;
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.#path, 'utf8'));
      this.#value = {
        provider: 'openai-compatible',
        baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : DEFAULTS.baseUrl,
        model: typeof parsed.model === 'string' ? parsed.model : '',
      };
      this.#encryptedApiKey = typeof parsed.apiKey === 'string' ? parsed.apiKey : undefined;
    } catch {
      this.#value = { ...DEFAULTS };
      this.#encryptedApiKey = undefined;
    }
  }

  rendererValue() {
    return {
      ...this.#value,
      apiKeyConfigured: Boolean(this.#encryptedApiKey),
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
    };
  }

  runtimeValue() {
    return {
      ...this.#value,
      apiKey: this.#decryptApiKey(),
    };
  }

  async save(input) {
    const baseUrl = typeof input?.baseUrl === 'string' ? input.baseUrl.trim() : '';
    const model = typeof input?.model === 'string' ? input.model.trim() : '';
    if (!baseUrl) throw new Error('Provider base URL is required');
    let parsed;
    try { parsed = new URL(baseUrl); } catch { throw new Error('Provider base URL must be a valid URL'); }
    if (parsed.protocol !== 'https:' && !isLocalhost(parsed.hostname)) {
      throw new Error('Provider base URL must use HTTPS unless it points to localhost');
    }
    this.#value = { provider: 'openai-compatible', baseUrl: baseUrl.replace(/\/+$/, ''), model };

    if (typeof input?.apiKey === 'string' && input.apiKey.trim()) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('OS credential encryption is unavailable; Cuppet will not persist the API key in plaintext');
      }
      this.#encryptedApiKey = safeStorage.encryptString(input.apiKey.trim()).toString('base64');
    }

    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(this.#path, `${JSON.stringify({ ...this.#value, apiKey: this.#encryptedApiKey }, null, 2)}\n`, { mode: 0o600 });
    return this.rendererValue();
  }

  #decryptApiKey() {
    if (!this.#encryptedApiKey) return '';
    if (!safeStorage.isEncryptionAvailable()) return '';
    try {
      return safeStorage.decryptString(Buffer.from(this.#encryptedApiKey, 'base64'));
    } catch {
      return '';
    }
  }
}

function isLocalhost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}
