import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function resolveProjectFilePath(root, value) {
  const { actual, child } = await resolveProjectFileDetails(root, value);
  return { actual, child };
}

export async function resolveProjectFileDetails(root, value) {
  const path = /^file:/i.test(value) ? fileURLToPath(value) : value;
  let requested = resolve(root, path);
  let actual;
  try { actual = await realpath(requested); }
  catch (error) {
    const decoded = decodeURIComponent(path);
    if (decoded === path) throw error;
    requested = resolve(root, decoded);
    actual = await realpath(requested);
  }
  const child = relative(root, actual);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error('File path escapes the project workspace.');
  const stats = await stat(actual);
  if (!stats.isFile()) throw new Error('Only project files can be opened from chat.');
  return { actual, child, requested, mode: stats.mode };
}
