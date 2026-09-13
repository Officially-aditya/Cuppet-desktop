export const ACTIVE_RUN_PHASES = Object.freeze([
  'preparing',
  'provider_starting',
  'streaming',
  'waiting_for_user',
  'tool_running',
  'waiting_for_provider',
  'settling',
]);

export const TERMINAL_RUN_PHASES = Object.freeze([
  'complete',
  'stopped',
  'interrupted',
  'error',
]);

const PHASES = new Set([...ACTIVE_RUN_PHASES, ...TERMINAL_RUN_PHASES]);

export function normalizeRunPhase(value, status = null) {
  const phase = String(value ?? '').trim().toLowerCase();
  if (PHASES.has(phase)) return phase;
  return phaseFromRunStatus(status);
}

export function phaseFromRunStatus(status) {
  switch (String(status ?? '').trim().toLowerCase()) {
    case 'starting': return 'preparing';
    case 'running': return 'streaming';
    case 'waiting': return 'waiting_for_user';
    case 'settling': return 'settling';
    case 'complete': return 'complete';
    case 'stopped': return 'stopped';
    case 'interrupted': return 'interrupted';
    case 'error': return 'error';
    default: return 'error';
  }
}

export function statusForRunPhase(value) {
  const phase = normalizeRunPhase(value);
  switch (phase) {
    case 'preparing': return 'starting';
    case 'waiting_for_user': return 'waiting';
    case 'settling': return 'settling';
    case 'complete': return 'complete';
    case 'stopped': return 'stopped';
    case 'interrupted': return 'interrupted';
    case 'error': return 'error';
    default: return 'running';
  }
}

export function isTerminalRunPhase(value) {
  return TERMINAL_RUN_PHASES.includes(normalizeRunPhase(value));
}
