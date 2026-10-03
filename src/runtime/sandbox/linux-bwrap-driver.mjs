import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
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
    '--unshare-user',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--die-with-parent',
    '--new-session',
    '--cap-drop', 'ALL',
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

  // Expose installed toolchains, not the entire home directory and its credentials.
  args.push('--dir', userHome);
  const toolchainDirs = [
    join(userHome, '.cargo', 'bin'), join(userHome, '.rustup'),
    ...['NVM_DIR', 'PYENV_ROOT', 'RUSTUP_HOME', 'GOROOT', 'JAVA_HOME', 'CONDA_PREFIX', 'VIRTUAL_ENV'].map((key) => process.env[key]),
    ...(process.env.PATH ?? '').split(':').filter((dir) => dir.startsWith(`${userHome}/`)),
  ];
  for (const dir of [...new Set(toolchainDirs.filter((value) => value && isAbsolute(value) && resolve(value) !== userHome))]) {
    if ((await stat(dir).catch(() => null))?.isDirectory()) args.push('--ro-bind', dir, dir);
  }
  args.push('--tmpfs', '/tmp');

  // Writable workspace (after the read-only home mount).
  args.push('--bind', root, root);

  if (Array.isArray(policy.scratchDirs)) {
    for (const dir of policy.scratchDirs) {
      if (typeof dir === 'string' && dir.trim()) {
        const resolved = await realpath(dir).catch(() => resolve(dir));
        args.push('--bind', resolved, resolved);
      }
    }
  }

  // Hide sensitive credentials by masking them with empty tmpfs
  {
    for (const relPath of SENSITIVE_HOST_PATHS) {
      const fullPath = join(userHome, relPath);
      const metadata = await stat(fullPath).catch(() => null);
      if (metadata?.isDirectory()) args.push('--tmpfs', fullPath);
      else if (metadata) args.push('--ro-bind', '/dev/null', fullPath);
    }
    for (const path of policy.protectedPaths ?? []) args.push('--tmpfs', path);
    for (const dir of policy.brokerJobDirs ?? []) args.push('--bind', dir, dir);
  }

  // Network unsharing
  if (policy.offline === true) {
    args.push('--unshare-net');
  }

  args.push('--', '/bin/sh', '-c', command);

  return {
    command: '/usr/bin/bwrap',
    args,
    shell: false,
  };
}
