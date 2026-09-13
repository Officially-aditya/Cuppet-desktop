import { useSyncExternalStore } from 'react';
import type { ProviderSettings } from '../types';
import { PROVIDER_SETTINGS_EVENT } from './provider-settings-events';

let settings: ProviderSettings | null = null;
let refreshPromise: Promise<ProviderSettings> | null = null;
const listeners = new Set<() => void>();
let listening = false;

export function useClientProviderSettings(): ProviderSettings | null {
  return useSyncExternalStore(subscribeClientProviderSettings, clientProviderSettingsSnapshot, clientProviderSettingsSnapshot);
}

export function clientProviderSettingsSnapshot(): ProviderSettings | null {
  return settings;
}

export function hydrateClientProviderSettings(next: ProviderSettings | null) {
  if (settings === next) return settings;
  settings = next;
  notify();
  return settings;
}

export async function refreshClientProviderSettings() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = window.cuppet.settings.get().then((next) => {
    hydrateClientProviderSettings(next);
    return next;
  }).finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

export function resetClientProviderStateStore() {
  stopListening();
  settings = null;
  refreshPromise = null;
  listeners.clear();
}

function subscribeClientProviderSettings(listener: () => void) {
  listeners.add(listener);
  ensureListening();
  if (!settings) void refreshClientProviderSettings().catch(() => undefined);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) stopListening();
  };
}

function ensureListening() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener(PROVIDER_SETTINGS_EVENT, onProviderSettingsChanged);
}

function stopListening() {
  if (!listening || typeof window === 'undefined') return;
  listening = false;
  window.removeEventListener(PROVIDER_SETTINGS_EVENT, onProviderSettingsChanged);
}

function onProviderSettingsChanged() {
  void refreshClientProviderSettings().catch(() => undefined);
}

function notify() {
  for (const listener of listeners) listener();
}
