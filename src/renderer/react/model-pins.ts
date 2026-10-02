import { useSyncExternalStore } from 'react';

const PREF_MODEL_PINS = 'cuppet.desktop.pref.model-pins';
type ModelPins = Readonly<Record<string, readonly string[]>>;
const EMPTY_PINS: readonly string[] = [];
let pins: ModelPins = readPins();
const listeners = new Set<() => void>();

export function usePinnedModels(providerID: string): readonly string[] {
  const snapshot = useSyncExternalStore(subscribe, modelPinsSnapshot, modelPinsSnapshot);
  return providerPins(snapshot, providerID);
}

export function modelPinsSnapshot(): ModelPins { return pins; }

export function togglePinnedModel(providerID: string, modelID: string) {
  if (!providerID || !modelID) return;
  const current = providerPins(pins, providerID);
  const next = current.includes(modelID) ? current.filter((id) => id !== modelID) : [...current, modelID];
  pins = { ...pins, [providerID]: next };
  try { localStorage.setItem(PREF_MODEL_PINS, JSON.stringify(pins)); } catch {}
  for (const listener of listeners) listener();
}

export function orderPinnedModels<T extends { id: string }>(models: readonly T[], pinned: readonly string[]): T[] {
  const order = new Map(pinned.map((id, index) => [id, index]));
  return [...models].sort((a, b) => (order.get(a.id) ?? pinned.length) - (order.get(b.id) ?? pinned.length));
}

function providerPins(snapshot: ModelPins, providerID: string): readonly string[] {
  return Object.prototype.hasOwnProperty.call(snapshot, providerID) ? snapshot[providerID] : EMPTY_PINS;
}

function readPins(): ModelPins {
  try {
    const value = JSON.parse(localStorage.getItem(PREF_MODEL_PINS) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, ids]) => Array.isArray(ids)).map(([provider, ids]) => [provider, [...new Set((ids as unknown[]).filter((id): id is string => typeof id === 'string' && Boolean(id)))]]));
  } catch { return {}; }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
