import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readlinkSync, realpathSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const POSIX_SOCKET_PLATFORMS = new Set(['darwin', 'linux']);

export function prepareManagedTstDataDir(dataDir, {
  platform = process.platform,
  uid = typeof process.getuid === 'function' ? process.getuid() : 'user',
} = {}) {
  if (!dataDir) return dataDir;
  const requested = resolve(dataDir);
  if (!POSIX_SOCKET_PLATFORMS.has(platform)) return requested;

  // The TST daemon stores durable state below dataDir, but its Unix socket must
  // stay below macOS/Linux sockaddr_un path limits. A private /tmp symlink gives
  // the manager a short textual path while all project/global data still lands
  // in the normal persistent application data directory.
  mkdirSync(requested, { recursive: true, mode: 0o700 });
  chmodSync(requested, 0o700);
  const durable = realpathSync(requested);
  const owner = String(uid).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32) || 'user';
  const root = join('/tmp', `cuppet-tst-${owner}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootStats = lstatSync(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error(`Unsafe managed TST socket root: ${root}`);
  chmodSync(root, 0o700);

  const key = createHash('sha256').update(durable).digest('hex').slice(0, 16);
  const alias = join(root, key);
  try {
    symlinkSync(durable, alias, 'dir');
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }

  const aliasStats = lstatSync(alias);
  if (!aliasStats.isSymbolicLink()) throw new Error(`Managed TST data alias is not a symlink: ${alias}`);
  const target = resolve(dirname(alias), readlinkSync(alias));
  if (realpathSync(target) !== durable) throw new Error(`Managed TST data alias points at an unexpected location: ${alias}`);
  return alias;
}
