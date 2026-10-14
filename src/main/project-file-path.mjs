import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function resolveProjectFilePath(root, value) {
  const path = /^file:/i.test(value) ? fileURLToPath(value) : value;
  let actual;
  try { actual = await realpath(resolve(root, path)); }
  catch (error) {
    const decoded = decodeURIComponent(path);
    if (decoded === path) throw error;
    actual = await realpath(resolve(root, decoded));
  }
  const child = relative(root, actual);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error('File path escapes the project workspace.');
  if (!(await stat(actual)).isFile()) throw new Error('Only project files can be opened from chat.');
  return { actual, child };
}
