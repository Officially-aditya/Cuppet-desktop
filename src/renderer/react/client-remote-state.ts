import { useSyncExternalStore } from 'react';
import type { RemoteStatus, RuntimeEvent } from '../types';

const EMPTY_REMOTE_STATUS: RemoteStatus = Object.freeze({});
let status: RemoteStatus = EMPTY_REMOTE_STATUS;
let initialized = false;
let refreshPromise: Promise<RemoteStatus> | null = null;
const listeners = new Set<() => void>();
let unsubscribeRuntime: (() => void) | null = null;

export function useClientRemoteStatus(): RemoteStatus {
  return useSyncExternalStore(subscribeClientRemoteStatus, clientRemoteStatusSnapshot, clientRemoteStatusSnapshot);
}

export function clientRemoteStatusSnapshot(): RemoteStatus {
  return status;
}

export function hydrateClientRemoteStatus(value: RemoteStatus | null | undefined) {
  const next = value && typeof value === 'object' ? { ...value } : EMPTY_REMOTE_STATUS;
  initialized = true;
  if (sameRemoteStatus(status, next)) return status;
  status = next;
  notify();
  return status;
}

export async function refreshClientRemoteStatus() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = window.cuppet.remote.status().then((next) => hydrateClientRemoteStatus(next)).finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

export function reduceClientRemoteEvent(event: RuntimeEvent) {
  const type = String(event?.type ?? '');
  if (type === 'remote.started' && event?.status && typeof event.status === 'object') {
    hydrateClientRemoteStatus(event.status);
    return true;
  }
  if (type === 'remote.setup' && event?.setup) {
    hydrateClientRemoteStatus({ ...status, starting: true, setup: event.setup });
    return true;
  }
  if (type === 'remote.device') {
    const activeDevices = Array.isArray(event?.devices) ? event.devices : [];
    hydrateClientRemoteStatus({
      ...status,
      deviceConnected: activeDevices.length > 0,
      activeDevice: activeDevices[0] ?? null,
      activeDevices,
    });
    return true;
  }
  if (type === 'remote.stopped') {
    hydrateClientRemoteStatus({
      ...status,
      running: false,
      starting: false,
      connected: false,
      deviceConnected: false,
      activeDevice: null,
      activeDevices: [],
      setup: null,
    });
    void refreshClientRemoteStatus().catch(() => undefined);
    return true;
  }
  if (type === 'remote.revoked') {
    void refreshClientRemoteStatus().catch(() => undefined);
    return true;
  }
  return false;
}

export function resetClientRemoteStateStore() {
  releaseRuntimeSubscription();
  status = EMPTY_REMOTE_STATUS;
  initialized = false;
  refreshPromise = null;
  listeners.clear();
}

function subscribeClientRemoteStatus(listener: () => void) {
  listeners.add(listener);
  ensureRuntimeSubscription();
  if (!initialized) void refreshClientRemoteStatus().catch(() => undefined);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) releaseRuntimeSubscription();
  };
}

function ensureRuntimeSubscription() {
  if (unsubscribeRuntime || typeof window === 'undefined' || !window.cuppet?.onEvent) return;
  unsubscribeRuntime = window.cuppet.onEvent((event) => {
    reduceClientRemoteEvent(event);
  });
}

function releaseRuntimeSubscription() {
  const unsubscribe = unsubscribeRuntime;
  unsubscribeRuntime = null;
  unsubscribe?.();
}

function sameRemoteStatus(current: RemoteStatus, next: RemoteStatus) {
  const currentKeys = Object.keys(current);
  const nextKeys = Object.keys(next);
  if (currentKeys.length !== nextKeys.length) return false;
  return nextKeys.every((key) => Object.is((current as Record<string, unknown>)[key], (next as Record<string, unknown>)[key]));
}

function notify() {
  for (const listener of listeners) listener();
}
