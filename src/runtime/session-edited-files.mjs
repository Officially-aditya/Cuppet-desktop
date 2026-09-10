import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_FILE_EVENTS = 1024;

export async function listSessionEditedFiles(dataDir, sessionId) {
  const id = String(sessionId ?? '').trim().slice(0, 256);
  if (!id) return [];
  const path = join(dataDir, 'mutation-journal', `${hash(id)}.json`);
  let decoded;
  try { decoded = JSON.parse(await readFile(path, 'utf8')); }
  catch { return []; }
  if (!decoded || decoded.sessionId !== id || !Array.isArray(decoded.entries)) return [];

  const events = [];
  for (const entry of decoded.entries) {
    if (!entry || entry.state !== 'applied') continue;
    const rawPaths = entry.kind === 'batch'
      ? (Array.isArray(entry.files) ? entry.files.map((file) => file?.path) : [])
      : entry.kind === 'file'
        ? [entry.path]
        : entry.kind === 'barrier' && Array.isArray(entry.paths)
          ? entry.paths
          : [];
    const seen = new Set();
    for (const raw of rawPaths) {
      const filePath = normalizeRelativePath(raw);
      if (!filePath || seen.has(filePath)) continue;
      seen.add(filePath);
      events.push({
        path: filePath,
        tool: String(entry.tool ?? 'edit').slice(0, 80),
        updatedAt: Number.isFinite(entry.createdAt) ? entry.createdAt : 0,
        mutationId: typeof entry.id === 'string' ? entry.id.slice(0, 160) : null,
        executionId: typeof entry.executionId === 'string' ? entry.executionId.slice(0, 256) : null,
      });
    }
  }

  return events
    .sort((a, b) => a.updatedAt - b.updatedAt || a.path.localeCompare(b.path))
    .slice(-MAX_FILE_EVENTS);
}

function normalizeRelativePath(value) {
  const path = String(value ?? '').trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (!path || path.startsWith('/') || path === '..' || path.startsWith('../') || path.includes('/../') || path.includes('\0')) return '';
  return path.slice(0, 1024);
}

function hash(value) {
  return createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('hex');
}
