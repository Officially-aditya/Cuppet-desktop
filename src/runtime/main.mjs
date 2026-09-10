import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { RuntimeService } from './service.mjs';
import { ConversationDatabase } from './database.mjs';
import { RemoteManager } from './remote/manager.mjs';
import { normalizeProviderConfiguration } from './provider-policy.mjs';
import { buildRuntimeDoctor, buildRuntimeStatus } from './diagnostics.mjs';
import { RuntimeTstManager } from './runtime-tst-manager.mjs';
import { closeProviderUsageLedger, providerUsageSummary } from './usage-ledger.mjs';

const dataDir = process.env.CUPPET_DATA_DIR || join(homedir(), '.cuppet-desktop');
const databasePath = join(dataDir, 'conversations.sqlite3');
const MAX_QUEUED_TURNS = 16;

const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let remote;
const activeSessions = new Set();
const queuedTurns = new Map();
const queueOwnerByRun = new Map();
const emit = (event) => {
  if (event?.type === 'run.started' && event.sessionId) activeSessions.add(event.sessionId);
  if (event?.type === 'run.finished' && event.sessionId) {
    activeSessions.delete(event.sessionId);
    const owner = queueOwnerByRun.get(event.sessionId) ?? event.sessionId;
    queueOwnerByRun.delete(event.sessionId);
    queueMicrotask(() => void drainQueued(owner));
  }
  write({ kind: 'event', event });
  remote?.handleRuntimeEvent(event);
};
const localState = new ConversationDatabase(databasePath);
const tst = new RuntimeTstManager({ dataDir: join(dataDir, 'tst') });
const runtimeService = new RuntimeService({ databasePath, dataDir, emit, tst });
const service = {
  async handle(method, params = {}) {
    const context = tstContext(method, params);
    const result = await tst.runWithProject(context, async () => {
      if (method === 'tst.status') return tst.status;
      if (method === 'tst.graph.locate') return tst.graphLocate(String(params.pattern ?? '').slice(0, 512), typeof params.prefix === 'string' ? params.prefix.slice(0, 512) : undefined, Math.min(12, Math.max(1, Number(params.limit) || 12)));
      if (method === 'tst.graph.refresh') return tst.refreshGraphPaths(Array.isArray(params.paths) ? params.paths.slice(0, 64) : []);
      return runtimeService.handle(method, params);
    });
    if ((method === 'project.remove' || method === 'project.relocate') && params.projectId) await tst.unregisterProject(params.projectId).catch(() => undefined);
    return result;
  },
  async close() { await Promise.all([runtimeService.close(), tst.close()]); },
};
remote = new RemoteManager({ dataDir, call: (method, params) => handle(method, params), emit });

async function handle(method, params = {}) {
  switch (method) {
    case 'status': return buildRuntimeStatus({ call: (name, value) => service.handle(name, value), providerConfig: boundedProvider(params.provider), version: '0.9.0-alpha.1' });
    case 'doctor': return buildRuntimeDoctor({ call: (name, value) => service.handle(name, value), providerConfig: boundedProvider(params.provider), version: '0.9.0-alpha.1' });
    case 'usage.summary': return providerUsageSummary();
    case 'session.send': return sendOrQueue(params);
    case 'session.search': return localState.search(String(params.query ?? '').slice(0, 512), { limit: params.limit, includeArchived: params.includeArchived === true });
    case 'session.rename': return renameSession(params);
    case 'session.archive': return archiveSession(params, true);
    case 'session.restore': return archiveSession(params, false);
    case 'session.delete': return deleteSession(params);
    case 'project.rename': return renameProject(params);
    case 'remote.status': return remote.status();
    case 'remote.start': return remote.start({ ...params, provider: boundedProvider(params.provider) });
    case 'remote.stop': return remote.stop();
    case 'remote.invite': return remote.createInvite({ role: params.role === 'viewer' ? 'viewer' : 'trusted', ...(Number.isFinite(params.ttlMs) ? { ttlMs: Math.max(1000, Math.min(Math.trunc(params.ttlMs), 10 * 60_000)) } : {}) });
    case 'remote.devices': return remote.devices();
    case 'remote.revoke': return remote.revoke(String(params.deviceId ?? '').slice(0, 128));
    case 'remote.provider-config': return remote.setProviderConfig(boundedProvider(params.provider));
    default: return service.handle(method, params);
  }
}

function tstContext(method, params = {}) {
  const sessionId = boundedId(params.sessionId ?? params.sourceSessionId);
  let projectId = boundedId(params.projectId);
  if (sessionId) {
    const session = localState.getSessionSummary(sessionId);
    if (session?.projectId) projectId = session.projectId;
  }
  if (!projectId && method === 'session.create') projectId = boundedId(params.projectId);
  const project = projectId ? localState.getProject(projectId) : null;
  return { sessionId: sessionId || null, projectId: project?.id ?? (projectId || null), projectRoot: project?.canonicalPath ?? null };
}

function renameSession(params = {}) {
  const sessionId = boundedId(params.sessionId);
  const title = String(params.title ?? '').trim().slice(0, 160);
  if (!sessionId) throw new Error('sessionId is required');
  if (!title) throw new Error('chat title is required');
  const session = localState.renameSession(sessionId, title);
  if (!session) throw new Error(`unknown session: ${sessionId}`);
  emit({ type: 'session.updated', session });
  return session;
}

function archiveSession(params = {}, archived) {
  const sessionId = boundedId(params.sessionId);
  if (!sessionId) throw new Error('sessionId is required');
  assertSessionIdle(sessionId, archived ? 'archive' : 'restore');
  const session = localState.archiveSession(sessionId, archived);
  emit({ type: archived ? 'session.archived' : 'session.restored', session, sessionId });
  return session;
}

function deleteSession(params = {}) {
  const sessionId = boundedId(params.sessionId);
  if (!sessionId) throw new Error('sessionId is required');
  assertSessionIdle(sessionId, 'delete');
  if (!localState.getSessionSummary(sessionId)) throw new Error(`unknown session: ${sessionId}`);
  const deleted = localState.deleteSession(sessionId);
  emit({ type: 'session.deleted', sessionId });
  return { deleted, sessionId };
}

function renameProject(params = {}) {
  const projectId = boundedId(params.projectId);
  const name = String(params.name ?? '').trim().slice(0, 120);
  if (!projectId) throw new Error('projectId is required');
  if (!name) throw new Error('project name is required');
  const project = localState.renameProject(projectId, name);
  if (!project) throw new Error(`unknown project: ${projectId}`);
  emit({ type: 'project.updated', project });
  return project;
}

function assertSessionIdle(sessionId, action) {
  if (activeSessions.has(sessionId)) throw new Error(`cannot ${action} a chat while it is generating`);
  if (queuedTurns.get(sessionId)?.length) throw new Error(`cannot ${action} a chat while it has queued messages`);
}

async function sendOrQueue(params = {}) {
  const sessionId = String(params.sessionId ?? '');
  if (!sessionId) return service.handle('session.send', params);
  if (!activeSessions.has(sessionId)) return service.handle('session.send', params);

  const queue = queuedTurns.get(sessionId) ?? [];
  if (queue.length >= MAX_QUEUED_TURNS) throw new Error(`session queue is full (${MAX_QUEUED_TURNS} messages)`);
  const item = {
    id: `queue_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    params: { ...params, sessionId },
    queuedAt: Date.now(),
  };
  queue.push(item);
  queuedTurns.set(sessionId, queue);
  emit({ type: 'queue.queued', sessionId, queueId: item.id, position: queue.length, queuedAt: item.queuedAt });
  return { accepted: true, queued: true, sessionId, queueId: item.id, position: queue.length };
}

async function drainQueued(ownerSessionId) {
  if (!ownerSessionId || activeSessions.has(ownerSessionId)) return;
  const queue = queuedTurns.get(ownerSessionId);
  if (!queue?.length) return;
  const item = queue.shift();
  if (!queue.length) queuedTurns.delete(ownerSessionId);
  emit({ type: 'queue.started', sessionId: ownerSessionId, queueId: item.id, queuedAt: item.queuedAt });
  try {
    const result = await service.handle('session.send', item.params);
    const runSessionId = result?.sessionId ?? ownerSessionId;
    queueOwnerByRun.set(runSessionId, ownerSessionId);
    emit({ type: 'queue.dispatched', sessionId: ownerSessionId, runSessionId, queueId: item.id });
    if (!activeSessions.has(runSessionId)) queueMicrotask(() => void drainQueued(ownerSessionId));
  } catch (error) {
    emit({ type: 'queue.failed', sessionId: ownerSessionId, queueId: item.id, message: cleanError(error) });
    queueMicrotask(() => void drainQueued(ownerSessionId));
  }
}

write({ kind: 'event', event: { type: 'runtime.ready', databasePath } });

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', async (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
    if (!request || typeof request !== 'object' || typeof request.id !== 'string' || typeof request.method !== 'string') throw new Error('invalid runtime request');
  } catch (error) {
    write({ kind: 'protocol-error', error: error instanceof Error ? error.message : String(error) });
    return;
  }
  try {
    const result = await handle(request.method, request.params ?? {});
    write({ kind: 'response', id: request.id, ok: true, result });
  } catch (error) {
    write({ kind: 'response', id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

let closing;
async function shutdown() {
  if (closing) return closing;
  closing = remote.close().catch(() => undefined)
    .then(() => service.close()).catch(() => undefined)
    .then(() => closeProviderUsageLedger()).catch(() => undefined)
    .then(() => localState.close()).catch(() => undefined)
    .finally(() => process.exit(0));
  return closing;
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
process.stdin.on('end', () => void shutdown());

function boundedProvider(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalized = normalizeProviderConfiguration({
    ...source,
    ...(typeof source.apiKey === 'string' ? { apiKey: source.apiKey.slice(0, 8192) } : {}),
    ...(typeof source.baseUrl === 'string' ? { baseUrl: source.baseUrl.slice(0, 500) } : {}),
    ...(Array.isArray(source.models) ? { models: source.models.slice(0, 512) } : {}),
    ...(Array.isArray(source.integrations) ? { integrations: source.integrations.slice(0, 256) } : {}),
  });
  return normalized;
}

function boundedId(value) { return typeof value === 'string' ? value.slice(0, 256) : ''; }
function cleanError(error) {
  return (error instanceof Error ? error.message : String(error)).replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]').slice(0, 500);
}
