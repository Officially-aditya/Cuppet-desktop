export const PROVIDER_SETTINGS_EVENT = 'cuppet:provider-settings-changed';
export const PROVIDER_CATALOG_INVALID_EVENT = 'cuppet:provider-catalog-invalidated';

export function notifyProviderSettingsChanged() {
  window.dispatchEvent(new CustomEvent(PROVIDER_SETTINGS_EVENT));
}

export function notifyProviderCatalogInvalid() {
  window.dispatchEvent(new CustomEvent(PROVIDER_CATALOG_INVALID_EVENT));
}
