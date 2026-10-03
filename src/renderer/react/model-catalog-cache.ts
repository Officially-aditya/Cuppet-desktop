import type { ProviderModelCatalog, ProviderSettings } from '../types';

type ModelEfforts = { reasoning?: ProviderModelCatalog['reasoning']; fetchedAt?: number };
type ProviderCache = { catalog: ProviderModelCatalog; efforts: Record<string, ModelEfforts>; fetchedAt?: number };
type LoadOptions = { model?: string; refresh?: boolean; maxAgeMs?: number };
const CACHE_KEY = 'cuppet.desktop.model-catalog-cache';
export const CATALOG_FRESH_MS = 5 * 60 * 1000;
let cache: Record<string, ProviderCache> = readCache();
const pending = new Map<string, Promise<ProviderModelCatalog>>();
let cacheRevision = 0;

export function cachedProviderCatalog(settings: ProviderSettings): ProviderModelCatalog | null {
  const entry = cache[providerKey(settings)];
  return validCatalog(entry?.catalog, providerID(settings)) && entry?.efforts && typeof entry.efforts === 'object' && !Array.isArray(entry.efforts) ? entry.catalog : null;
}

export function cachedModelCatalog(settings: ProviderSettings, model = settings.primary?.modelID || ''): ProviderModelCatalog | null {
  const catalog = cachedProviderCatalog(settings);
  if (!catalog) return null;
  if (!catalog.modelDependentSettings) return { ...catalog, configuredModel: model || null };
  const models = cache[providerKey(settings)].efforts;
  if (!Object.prototype.hasOwnProperty.call(models, model)) return null;
  const efforts = models[model];
  if (!efforts || typeof efforts !== 'object' || Array.isArray(efforts) || (efforts.reasoning && !validReasoning(efforts.reasoning))) return null;
  return { ...catalog, configuredModel: model, reasoning: efforts.reasoning, fetchedAt: efforts.fetchedAt };
}

export function isProviderCatalogStale(settings: ProviderSettings, maxAgeMs?: number, now = Date.now()): boolean {
  const fetchedAt = Number(cache[providerKey(settings)]?.fetchedAt);
  if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) return true;
  return now - fetchedAt >= freshnessWindow(maxAgeMs);
}

export function invalidateModelCatalogCache(settings: ProviderSettings | null = null): void {
  cacheRevision += 1;
  pending.clear();
  if (settings) delete cache[providerKey(settings)];
  else cache = {};
  persist();
}

export async function loadModelCatalog(settings: ProviderSettings, { model, refresh = false, maxAgeMs }: LoadOptions = {}): Promise<ProviderModelCatalog> {
  const selectedModel = model || settings.primary?.modelID || '';
  if (!refresh) {
    const cached = cachedModelCatalog(settings, selectedModel);
    if (cached && !isProviderCatalogStale(settings, maxAgeMs)) return cached;
  }
  const key = JSON.stringify([providerKey(settings), selectedModel]);
  const existing = pending.get(key);
  if (existing) return existing;
  const revision = cacheRevision;
  const request = (model ? window.cuppet.settings.models({ model }) : window.cuppet.settings.models())
    .then((catalog) => {
      if (revision !== cacheRevision) return catalog;
      if (validCatalog(catalog, providerID(settings)) && !(catalog as ProviderModelCatalog & { stale?: boolean }).stale) {
        const scope = providerKey(settings);
        const entry = { catalog, efforts: { ...(cache[scope]?.efforts ?? {}) }, fetchedAt: discoveredAt(catalog) };
        if (catalog.modelDependentSettings && catalog.configuredModel && (!catalog.reasoning || validReasoning(catalog.reasoning))) {
          entry.efforts = { ...entry.efforts, [catalog.configuredModel]: { reasoning: catalog.reasoning, fetchedAt: catalog.fetchedAt } };
        }
        cache[scope] = entry;
      } else if (catalog.providerID === providerID(settings) && !catalog.error && Array.isArray(catalog.models) && !catalog.models.length) {
        delete cache[providerKey(settings)];
      }
      persist();
      return catalog;
    }).finally(() => { if (pending.get(key) === request) pending.delete(key); });
  pending.set(key, request);
  return request;
}

function persist(): void {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch {}
}

function readCache(): Record<string, ProviderCache> {
  try {
    const value = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function discoveredAt(catalog: ProviderModelCatalog): number {
  const value = Number(catalog.fetchedAt);
  return Number.isFinite(value) && value > 0 ? value : Date.now();
}

function freshnessWindow(maxAgeMs?: number): number {
  return typeof maxAgeMs === 'number' && maxAgeMs >= 0 ? maxAgeMs : CATALOG_FRESH_MS;
}

function providerID(settings: ProviderSettings) { return settings.primary?.providerID || settings.providerID || ''; }
function providerKey(settings: ProviderSettings) { return JSON.stringify([providerID(settings), settings.baseUrl || '']); }
function validCatalog(catalog: ProviderModelCatalog | undefined, provider: string): catalog is ProviderModelCatalog {
  return Boolean(catalog && catalog.providerID === provider && catalog.available === true && !catalog.error && Array.isArray(catalog.models) && catalog.models.length && catalog.models.every((model) => typeof model?.id === 'string'));
}
function validReasoning(reasoning: NonNullable<ProviderModelCatalog['reasoning']>) {
  return typeof reasoning.configId === 'string' && (reasoning.currentValue == null || typeof reasoning.currentValue === 'string') && Array.isArray(reasoning.options) && reasoning.options.every((option) => typeof option?.id === 'string');
}
