import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_FILES = 128;

export async function listSessionEditedFiles(dataDir, sessionId) {
  const id = String(sessionId ?? '').trim().slice(0, 256);
  if (!id) return [];
  const path = join(dataDir, 'mutation-journal', `${hash(id)}.json`);
  let decoded;
  try { decoded = JSON.parse(await readFile(path, 'utf8')); }
  catch { return []; }
  if (!decoded || decoded.sessionId !== id || !Array.isArray(decoded.entries)) return [];

  const byPath = new Map();
  for (const entry of decoded.entries) {
    if (!entry || entry.state !== 'applied') continue;
    const paths = entry.kind === 'batch'
      ? (Array.isArray(entry.files) ? entry.files.map((file) => file?.path) : [])
      : entry.kind === 'file'
        ? [entry.path]
        : entry.kind === 'barrier' && Array.isArray(entry.paths)
          ? entry.paths
          : [];
    for (const raw of paths) {
      const filePath = normalizeRelativePath(raw);
      if (!filePath) continue;
      byPath.set(filePath, {
        path: filePath,
        tool: String(entry.tool ?? 'edit').slice(0, 80),
        updatedAt: Number.isFinite(entry.createdAt) ? entry.createdAt : 0,
      });
    }
  }

  return [...byPath.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt || a.path.localeCompare(b.path))
    .slice(0, MAX_FILES);
}

function normalizeRelativePath(value) {
  const path = String(value ?? '').trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (!path || path.startsWith('/') || path === '..' || path.startsWith('../') || path.includes('/../') || path.includes('\0')) return '';
  return path.slice(0, 1024);
}

function hash(value) {
  return createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('hex');
}
