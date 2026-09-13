import { providerProjection } from './provider-policy.mjs';
import { providerRuntimeHealth } from './providers/runtime-health-registry.mjs';

export async function buildRuntimeStatus({ call, providerConfig = {}, version = '0.8.0-alpha.1' }) {
  if (typeof call !== 'function') throw new Error('diagnostics require a runtime call function');
  const [healthResult, projectsResult, sessionsResult, permissionsResult, cognitiveResult] = await Promise.all([
    safeCall(call, 'health'),
    safeCall(call, 'project.list'),
    safeCall(call, 'session.list'),
    safeCall(call, 'permission.list'),
    safeCall(call, 'cognitive.status'),
  ]);
  const health = record(healthResult.value);
  const projects = array(projectsResult.value);
  const sessions = array(sessionsResult.value);
  const permissions = array(permissionsResult.value);
  const cognitive = record(cognitiveResult.value);
  const projection = providerProjection(providerConfig);
  const supervisor = providerRuntimeHealth(projection.primary?.providerID ?? projection.providerID);
  const missingProjects = projects.filter((project) => project?.missing === true);
  const interrupted = sessions.filter((session) => ['interrupted', 'error'].includes(String(session?.lastStatus ?? '')));
  return {
    schema: 1,
    runtime: 'independent',
    version,
    ok: healthResult.ok && health.ok === true,
    activeRuns: integer(health.activeRuns),
    liveExecutions: integer(health.liveExecutions),
    projects: { total: projects.length, missing: missingProjects.length },
    sessions: { total: sessions.length, interruptedOrError: interrupted.length },
    permissions: { pending: permissions.length },
    provider: {
      configured: projection.configured,
      providerID: projection.providerID,
      primary: projection.primary ? { ...projection.primary } : null,
      secondary: projection.secondary ? { ...projection.secondary } : null,
      runtime: sanitizeProviderRuntime(supervisor),
    },
    cognitive: {
      orchestratorEnabled: cognitive.orchestratorEnabled === true,
      backgroundPaused: cognitive.backgroundPaused === true,
      tst: sanitizeTst(cognitive.tst),
      roles: record(cognitive.roles),
    },
    errors: compactErrors({ health: healthResult, projects: projectsResult, sessions: sessionsResult, permissions: permissionsResult, cognitive: cognitiveResult }),
  };
}

export async function buildRuntimeDoctor(options) {
  const status = await buildRuntimeStatus(options);
  const providerRuntimeHealthy = !['unhealthy', 'crashed'].includes(status.provider.runtime.state);
  const checks = [
    check('runtime', status.ok, status.ok ? 'Independent runtime is responsive.' : 'Independent runtime health check failed.', true),
    check('sessions', !status.errors.sessions, status.errors.sessions || `${status.sessions.total} durable sessions readable.`, true),
    check('projects', !status.errors.projects, status.errors.projects || `${status.projects.total} registered projects readable.`, true),
    check('permissions', !status.errors.permissions, status.errors.permissions || `${status.permissions.pending} permission requests pending.`, true),
    check('provider', status.provider.configured, status.provider.configured ? `Primary model ${displayRef(status.provider.primary)} is configured.` : 'Provider/model credentials are not fully configured.', false),
    check('provider-runtime', providerRuntimeHealthy, providerRuntimeHealthy ? `Provider runtime is ${status.provider.runtime.state}.` : `Provider runtime is ${status.provider.runtime.state}; ${status.provider.runtime.restarts} restart(s) and ${status.provider.runtime.preTurnRetries} safe pre-turn retry attempt(s) recorded.`, false),
    check('tst', status.cognitive.tst.connected === true, status.cognitive.tst.connected ? 'TST is connected.' : status.cognitive.tst.configured ? 'TST is configured but not connected.' : 'TST is optional and not configured.', false),
    check('project-paths', status.projects.missing === 0, status.projects.missing === 0 ? 'All registered project folders are present.' : `${status.projects.missing} registered project folder(s) are missing.`, false),
  ];
  return {
    schema: 1,
    runtime: status.runtime,
    version: status.version,
    ok: checks.filter((item) => item.required).every((item) => item.status === 'ok'),
    checks,
    warnings: checks.filter((item) => !item.required && item.status !== 'ok').map((item) => item.message),
    status,
  };
}

async function safeCall(call, method) {
  try { return { ok: true, value: await call(method, {}) }; }
  catch (error) { return { ok: false, value: null, error: cleanError(error) }; }
}
function compactErrors(values) {
  return Object.fromEntries(Object.entries(values).flatMap(([key, value]) => value.ok ? [] : [[key, value.error || 'unknown error']]));
}
function sanitizeProviderRuntime(value) {
  const source = record(value);
  return {
    state: ['stopped', 'starting', 'ready', 'busy', 'unhealthy', 'crashed'].includes(source.state) ? source.state : 'stopped',
    activeProcesses: integer(source.activeProcesses),
    readyProcesses: integer(source.readyProcesses),
    busyProcesses: integer(source.busyProcesses),
    generation: integer(source.generation),
    restarts: integer(source.restarts),
    preTurnRetries: integer(source.preTurnRetries),
    retryPolicy: sanitizeRetryPolicy(source.retryPolicy),
    lastRetry: sanitizeRetry(source.lastRetry),
    lastFailure: sanitizeFailure(source.lastFailure),
  };
}
function sanitizeRetryPolicy(value) {
  const source = record(value);
  return source.maxAttempts ? {
    maxAttempts: integer(source.maxAttempts),
    baseDelayMs: integer(source.baseDelayMs),
    maxDelayMs: integer(source.maxDelayMs),
  } : null;
}
function sanitizeRetry(value) {
  const source = record(value);
  return source.retry && source.at ? {
    retry: integer(source.retry),
    delayMs: integer(source.delayMs),
    at: integer(source.at),
    failure: sanitizeFailure(source.failure),
  } : null;
}
function sanitizeFailure(value) {
  const source = record(value);
  if (!Object.keys(source).length) return null;
  return {
    code: text(source.code, 120) || null,
    category: text(source.category, 120) || 'unknown',
    retryable: source.retryable === true,
    at: integer(source.at),
  };
}
function check(id, ok, message, required) { return { id, status: ok ? 'ok' : required ? 'error' : 'warning', required, message }; }
function displayRef(value) { return value ? `${value.providerID}/${value.modelID}${value.variant ? ` (${value.variant})` : ''}` : 'none'; }
function sanitizeTst(value) { const source = record(value); return { configured: source.configured === true, connected: source.connected === true }; }
function integer(value) { const number = Number(value); return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0; }
function array(value) { return Array.isArray(value) ? value : []; }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function text(value, limit = 1000) { return typeof value === 'string' ? value.trim().slice(0, limit) : ''; }
function cleanError(error) { return error instanceof Error ? error.message : String(error); }
