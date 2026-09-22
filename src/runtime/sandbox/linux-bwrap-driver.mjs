import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { SENSITIVE_HOST_PATHS } from './types.mjs';

/**
 * Builds the bubblewrap argument list for Linux.
 *
 * @param {string} command
 * @param {import('./types.mjs').SandboxPolicy} policy
 * @returns {Promise<{ command: string, args: string[], shell: boolean }>}
 */
export async function getLinuxBwrapSpawnSpec(command, policy) {
  const root = await realpath(policy.projectRoot).catch(() => resolve(policy.projectRoot));
  const userHome = homedir();

  const args = [
    // Unshare namespaces for isolation
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--proc', '/proc',
    '--dev', '/dev',
    // Mount core system paths read-only
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/lib', '/lib',
    '--ro-bind', '/etc', '/etc',
  ];

  // Optional 64-bit lib
  args.push('--ro-bind-try', '/lib64', '/lib64');
  args.push('--ro-bind-try', '/bin', '/bin');
  args.push('--ro-bind-try', '/sbin', '/sbin');
  args.push('--ro-bind-try', '/opt', '/opt');

  // Writable workspace
  args.push('--bind', root, root);

  // Writable /tmp
  args.push('--bind', '/tmp', '/tmp');

  if (Array.isArray(policy.scratchDirs)) {
    for (const dir of policy.scratchDirs) {
      if (typeof dir === 'string' && dir.trim()) {
        const resolved = await realpath(dir).catch(() => resolve(dir));
        args.push('--bind', resolved, resolved);
      }
    }
  }

  // Hide sensitive credentials by masking them with empty tmpfs
  if (policy.protectSensitiveCredentials !== false) {
    for (const relPath of SENSITIVE_HOST_PATHS) {
      const fullPath = join(userHome, relPath);
      if (root.startsWith(fullPath)) continue;
      args.push('--tmpfs', fullPath);
    }
  }

  // Network unsharing
  if (policy.offline === true) {
    args.push('--unshare-net');
  }

  args.push('--', '/bin/sh', '-c', command);

  return {
    command: 'bwrap',
    args,
    shell: false,
  };
}
