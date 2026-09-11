export const PROVIDER_SETTINGS_EVENT = 'cuppet:provider-settings-changed';

export function notifyProviderSettingsChanged() {
  window.dispatchEvent(new CustomEvent(PROVIDER_SETTINGS_EVENT));
}
