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
import { DELETED_CHAT_PURGE_INTERVAL_MS, DELETED_CHAT_RETENTION_MS, purgeSessionArtifacts } from './session-retention.mjs';
import { BrowserControlManager } from './browser-control-manager.mjs';
import { TurnStore } from './turn-store.mjs';
import { RunWaitProjection } from './run-wait-projection.mjs';
import { ProviderControlPlane } from './providers/control-plane.mjs';

const dataDir = process.env.CUPPET_DATA_DIR || join(homedir(), '.cuppet-desktop');
const databasePath = join(dataDir, 'conversations.sqlite3');
const MAX_QUEUED_TURNS = 16;

const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let remote;
const activeSessions = new Set();
const queueOwnerByRun = new Map();
const purgingSessions = new Set();
let purgePromise;
const localState = new ConversationDatabase(databasePath);
const turnStore = new TurnStore(localState.sqlRepository(), { legacyPath: join(dataDir, 'turn-state.sqlite3') });
const runWaits = new RunWaitProjection(localState.sqlRepository());
const providerControl = new ProviderControlPlane({ dataDir });
const emit = (event) => {
  runWaits.observe(event);
  if (event?.type === 'run.started' && event.sessionId) {
    activeSessions.add(event.sessionId);
    if (event.messageId) {
      turnStore.startRun({
        runId: event.messageId,
        sessionId: event.sessionId,
        sourceSessionId: event.sourceSessionId ?? null,
        projectId: event.projectId ?? null,
      });
    }
  }
  if (event?.type === 'run.finished' && event.sessionId) {
    activeSessions.delete(event.sessionId);
    if (event.messageId) {
      const message = localState?.getMessage?.(event.messageId);
      turnStore.finishRun(event.messageId, {
        status: message?.status ?? 'complete',
        ...(message?.status === 'error' ? { error: 'Generation failed.' } : {}),
      });
    }
    const owner = queueOwnerByRun.get(event.sessionId) ?? event.sessionId;
    queueOwnerByRun.delete(event.sessionId);
    queueMicrotask(() => void drainQueued(owner));
  }
  write({ kind: 'event', event });
  remote?.handleRuntimeEvent(event);
};
const tst = new RuntimeTstManager({ dataDir: join(dataDir, 'tst') });
const browserControl = new BrowserControlManager({ emit });
const runtimeService = new RuntimeService({ database: localState, databasePath, dataDir, emit, tst, browserControl });
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
  async close() { await Promise.all([runtimeService.close(), tst.close(), browserControl.close()]); },
};
remote = new RemoteManager({ dataDir, call: (method, params) => handle(method, params), emit });
const purgeTimer = setInterval(() => { void purgeExpiredDeleted(); }, DELETED_CHAT_PURGE_INTERVAL_MS);
purgeTimer.unref?.();

async function handle(method, params = {}) {
  switch (method) {
    case 'status': return buildRuntimeStatus({ call: (name, value) => service.handle(name, value), providerConfig: boundedProvider(params.provider), version: '0.9.0-alpha.1' });
    case 'doctor': return buildRuntimeDoctor({ call: (name, value) => service.handle(name, value), providerConfig: boundedProvider(params.provider), version: '0.9.0-alpha.1' });
    case 'usage.summary': return providerUsageSummary();
    case 'provider.local.status': return providerControl.localStatus(boundedProviderID(params.providerID));
    case 'provider.local.connect': return providerControl.localConnect(boundedProviderID(params.providerID));
    case 'provider.local.detect': return providerControl.localDetect(boundedProviderID(params.providerID));
    case 'provider.local.probe': return providerControl.localProbe(boundedProviderID(params.providerID));
    case 'provider.local.update': return providerControl.localUpdate(boundedProviderID(params.providerID));
    case 'provider.models': return providerControl.models(boundedProvider(params.provider), { model: typeof params.model === 'string' ? params.model.slice(0, 1000) : '' });
    case 'integration.browser.status': return browserControl.status();
    case 'integration.browser.connect': return browserControl.connect();
    case 'integration.browser.disconnect': return browserControl.disconnect();
    case 'session.list': { await purgeExpiredDeleted(); return service.handle('session.list', params); }
    case 'session.deleted.list': {
      await purgeExpiredDeleted();
      const now = Date.now();
      return localState.listSessions({ archived: true })
        .filter((session) => Number(session.deletedAt) > 0 && now - Number(session.deletedAt) < DELETED_CHAT_RETENTION_MS)
        .map((session) => ({ ...session, purgeAt: Number(session.deletedAt) + DELETED_CHAT_RETENTION_MS }));
    }
    case 'session.queue.list': return turnStore.listQueued(boundedId(params.sessionId));
    case 'session.run.latest': return turnStore.latestRun(boundedId(params.sessionId));
    case 'session.send': return sendOrQueue(params);
    case 'session.search': { await purgeExpiredDeleted(); return localState.search(String(params.query ?? '').slice(0, 512), { limit: params.limit, includeArchived: params.includeArchived === true }); }
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
  const existing = localState.getSessionSummary(sessionId);
  if (!existing) throw new Error(`unknown session: ${sessionId}`);
  if (!archived && existing.deletedAt && Date.now() - Number(existing.deletedAt) >= DELETED_CHAT_RETENTION_MS) {
    throw new Error("This chat's 7-day recovery window has expired.");
  }
  if (!archived && purgingSessions.has(sessionId)) throw new Error('This chat has reached the end of its 7-day recovery window and is being removed.');
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
  const session = localState.trashSession(sessionId);
  const purgeAt = Number(session.deletedAt) + DELETED_CHAT_RETENTION_MS;
  emit({ type: 'session.deleted', sessionId, session, purgeAt });
  return { deleted: true, archived: true, sessionId, deletedAt: session.deletedAt, purgeAt };
}

async function purgeExpiredDeleted(now = Date.now()) {
  if (purgePromise) return purgePromise;
  purgePromise = (async () => {
    const cutoff = now - DELETED_CHAT_RETENTION_MS;
    let purged = 0;
    for (const candidate of localState.listExpiredDeleted(cutoff, 100)) {
      const sessionId = boundedId(candidate.id);
      if (!sessionId || activeSessions.has(sessionId) || turnStore.hasQueued(sessionId) || purgingSessions.has(sessionId)) continue;
      const current = localState.getSession(sessionId);
      if (!current?.deletedAt || current.deletedAt > cutoff) continue;
      purgingSessions.add(sessionId);
      try {
        await service.handle('session.cleanup', { sessionId });
        await purgeSessionArtifacts({ dataDir, sessionId });
        const latest = localState.getSessionSummary(sessionId);
        if (!latest?.deletedAt || latest.deletedAt > cutoff) continue;
        const deleted = localState.deleteSession(sessionId);
        if (!deleted) continue;
        purged += 1;
        emit({
          type: 'session.purged',
          sessionId,
          messageIds: current.messages.map((message) => message.id),
          preserved: ['tst-memory', 'project-files'],
        });
      } catch (error) {
        emit({ type: 'session.purge.failed', sessionId, message: cleanError(error) });
      } finally {
        purgingSessions.delete(sessionId);
      }
    }
    return { purged, cutoff };
  })().finally(() => { purgePromise = undefined; });
  return purgePromise;
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
  if (turnStore.hasQueued(sessionId)) throw new Error(`cannot ${action} a chat while it has queued messages`);
}

async function sendOrQueue(params = {}) {
  const sessionId = String(params.sessionId ?? '');
  if (!sessionId) return service.handle('session.send', params);
  if (!activeSessions.has(sessionId)) return service.handle('session.send', params);

  const queuedCount = turnStore.countQueued(sessionId);
  if (queuedCount >= MAX_QUEUED_TURNS) throw new Error(`session queue is full (${MAX_QUEUED_TURNS} messages)`);
  const item = turnStore.enqueue({
    id: `queue_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    sessionId,
    params: { ...params, sessionId },
    queuedAt: Date.now(),
  });
  const position = turnStore.countQueued(sessionId);
  emit({ type: 'queue.queued', sessionId, queueId: item.id, position, queuedAt: item.queuedAt });
  return { accepted: true, queued: true, sessionId, queueId: item.id, position };
}

async function drainQueued(ownerSessionId) {
  if (!ownerSessionId || activeSessions.has(ownerSessionId)) return;
  const item = turnStore.claimNext(ownerSessionId);
  if (!item) return;
  emit({ type: 'queue.started', sessionId: ownerSessionId, queueId: item.id, queuedAt: item.queuedAt });
  try {
    const result = await service.handle('session.send', item.params);
    turnStore.completeQueue(item.id);
    const runSessionId = result?.sessionId ?? ownerSessionId;
    queueOwnerByRun.set(runSessionId, ownerSessionId);
    emit({ type: 'queue.dispatched', sessionId: ownerSessionId, runSessionId, queueId: item.id });
    if (!activeSessions.has(runSessionId)) queueMicrotask(() => void drainQueued(ownerSessionId));
  } catch (error) {
    turnStore.failQueue(item.id, error);
    emit({ type: 'queue.failed', sessionId: ownerSessionId, queueId: item.id, message: cleanError(error) });
    queueMicrotask(() => void drainQueued(ownerSessionId));
  }
}

write({ kind: 'event', event: { type: 'runtime.ready', databasePath } });
for (const sessionId of turnStore.queuedSessions()) {
  queueMicrotask(() => void drainQueued(sessionId));
}

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
  clearInterval(purgeTimer);
  closing = remote.close().catch(() => undefined)
    .then(() => service.close()).catch(() => undefined)
    .then(() => closeProviderUsageLedger()).catch(() => undefined)
    .then(() => turnStore.close()).catch(() => undefined)
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

function boundedProviderID(value) {
  const id = typeof value === 'string' ? value.trim().toLowerCase().slice(0, 80) : '';
  if (!id || !/^[a-z0-9._-]+$/.test(id)) throw new Error('A valid provider id is required.');
  return id;
}
function boundedId(value) { return typeof value === 'string' ? value.slice(0, 256) : ''; }
function cleanError(error) {
  return (error instanceof Error ? error.message : String(error)).replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]').slice(0, 500);
}