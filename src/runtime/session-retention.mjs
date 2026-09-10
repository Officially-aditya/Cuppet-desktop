import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const DELETED_CHAT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const DELETED_CHAT_PURGE_INTERVAL_MS = 60 * 60 * 1000;

export async function purgeSessionArtifacts({ dataDir, sessionId }) {
  const id = String(sessionId ?? '').trim();
  if (!id) throw new Error('sessionId is required');
  const digest = sha256(id);

  const results = await Promise.allSettled([
    rm(join(dataDir, 'lossless-plans', `${digest}.json`), { force: true }),
    rm(join(dataDir, 'mutation-journal', `${digest}.json`), { force: true }),
    forgetCognitiveSession(join(dataDir, 'cognitive-state.json'), id),
    forgetPe3Session(join(dataDir, 'pe3'), id),
  ]);

  const failed = results.filter((result) => result.status === 'rejected');
  if (failed.length) {
    const message = failed.map((result) => cleanError(result.reason)).join('; ');
    throw new Error(`session artifact cleanup failed: ${message}`);
  }

  return {
    sessionId: id,
    preserved: ['tst-memory', 'project-files'],
    purged: ['lossless-plan', 'mutation-journal', 'cognitive-session-state', 'pe3-task-state'],
  };
}

async function forgetCognitiveSession(path, sessionId) {
  let parsed;
  try { parsed = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  if (!parsed?.sessionModes || typeof parsed.sessionModes !== 'object' || Array.isArray(parsed.sessionModes) || !(sessionId in parsed.sessionModes)) return false;
  delete parsed.sessionModes[sessionId];
  await atomicJsonWrite(path, parsed);
  return true;
}

async function forgetPe3Session(root, sessionId) {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error?.code === 'ENOENT') return 0; throw error; }

  let changed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name, 'pe3-task-agents.json');
    let parsed;
    try { parsed = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
    if (!Array.isArray(parsed?.agents)) continue;

    const agents = parsed.agents.filter((agent) => agent?.sessionID !== sessionId);
    const activeRemoved = parsed.activeSessionID === sessionId;
    if (agents.length === parsed.agents.length && !activeRemoved) continue;

    changed += 1;
    if (!agents.length) {
      await rm(path, { force: true });
      continue;
    }

    const next = { ...parsed, agents };
    if (activeRemoved) delete next.activeSessionID;
    if (next.fileSignatures && typeof next.fileSignatures === 'object' && !Array.isArray(next.fileSignatures)) {
      const livePaths = new Set(agents.flatMap((agent) => [
        ...(Array.isArray(agent?.activePaths) ? agent.activePaths : []),
        ...(Array.isArray(agent?.touchedPaths) ? agent.touchedPaths : []),
      ].map(String)));
      next.fileSignatures = Object.fromEntries(Object.entries(next.fileSignatures).filter(([file]) => livePaths.has(file)));
    }
    await atomicJsonWrite(path, next);
  }
  return changed;
}

async function atomicJsonWrite(path, value) {
  const temporary = join(dirname(path), `.${sha256(path)}.${process.pid}.${randomBytes(5).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function sha256(value) { return createHash('sha256').update(String(value)).digest('hex'); }
function cleanError(error) { return (error instanceof Error ? error.message : String(error)).slice(0, 300); }
