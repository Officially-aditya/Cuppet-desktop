const FAILURE_TTL_MS = 5 * 60_000;

const liveByProvider = new Map();
const recentFailures = new Map();
let nextToken = 1;

export function registerProviderRuntime(providerID, snapshot) {
  const id = normalizeProviderID(providerID);
  if (!id || typeof snapshot !== 'function') return () => {};
  const token = nextToken++;
  let entries = liveByProvider.get(id);
  if (!entries) {
    entries = new Map();
    liveByProvider.set(id, entries);
  }
  entries.set(token, snapshot);
  return () => {
    const current = liveByProvider.get(id);
    current?.delete(token);
    if (!current?.size) liveByProvider.delete(id);
  };
}

export function recordProviderRuntimeFailure(providerID, failure, now = Date.now()) {
  const id = normalizeProviderID(providerID);
  if (!id) return;
  recentFailures.set(id, {
    ...sanitizeFailure(failure),
    at: Number(failure?.at) || now,
  });
}

export function clearProviderRuntimeFailure(providerID) {
  const id = normalizeProviderID(providerID);
  if (id) recentFailures.delete(id);
}

export function providerRuntimeHealth(providerID, now = Date.now()) {
  const id = normalizeProviderID(providerID);
  if (!id) return stoppedHealth();
  const snapshots = [];
  for (const read of liveByProvider.get(id)?.values?.() ?? []) {
    try {
      const value = read();
      if (value && typeof value === 'object') snapshots.push(value);
    } catch {}
  }

  let failure = recentFailures.get(id) ?? null;
  if (failure && now - Number(failure.at || 0) > FAILURE_TTL_MS) {
    recentFailures.delete(id);
    failure = null;
  }

  const states = snapshots.map(runtimeState);
  let state = 'stopped';
  if (states.includes('running')) state = 'busy';
  else if (states.includes('starting') || states.includes('idle')) state = 'starting';
  else if (states.includes('ready')) state = 'ready';
  else if (states.includes('error')) state = 'unhealthy';
  else if (!snapshots.length && failure) state = 'crashed';

  let restarts = 0;
  let generation = 0;
  let lastFailure = failure;
  for (const snapshot of snapshots) {
    const supervisor = snapshot?.supervisor && typeof snapshot.supervisor === 'object' ? snapshot.supervisor : {};
    restarts += Math.max(0, Number(supervisor.restarts) || 0);
    generation = Math.max(generation, Math.max(0, Number(supervisor.generation) || 0));
    if (supervisor.lastFailure && (!lastFailure || Number(supervisor.lastFailure.at || 0) > Number(lastFailure.at || 0))) {
      lastFailure = sanitizeFailure(supervisor.lastFailure);
    }
  }

  return Object.freeze({
    state,
    activeProcesses: snapshots.length,
    readyProcesses: states.filter((value) => value === 'ready').length,
    busyProcesses: states.filter((value) => value === 'running').length,
    generation,
    restarts,
    lastFailure: lastFailure ? Object.freeze(sanitizeFailure(lastFailure)) : null,
  });
}

export function resetProviderRuntimeHealthForTests() {
  liveByProvider.clear();
  recentFailures.clear();
  nextToken = 1;
}

function runtimeState(snapshot) {
  if (snapshot?.supervisor?.closed === true) return 'closed';
  const state = String(snapshot?.state ?? '').trim().toLowerCase();
  return ['idle', 'starting', 'ready', 'running', 'error', 'closed'].includes(state) ? state : 'unknown';
}

function sanitizeFailure(value) {
  return {
    code: cleanText(value?.code, 120) || null,
    category: cleanText(value?.category, 120) || 'unknown',
    retryable: value?.retryable === true,
    at: Math.max(0, Number(value?.at) || 0),
  };
}

function stoppedHealth() {
  return Object.freeze({
    state: 'stopped',
    activeProcesses: 0,
    readyProcesses: 0,
    busyProcesses: 0,
    generation: 0,
    restarts: 0,
    lastFailure: null,
  });
}

function normalizeProviderID(value) {
  const id = String(value ?? '').trim().toLowerCase();
  return /^[a-z0-9._-]+$/.test(id) ? id : '';
}

function cleanText(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}
