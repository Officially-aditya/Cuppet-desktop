import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { SENSITIVE_HOST_PATHS } from './types.mjs';

/**
 * Builds a hardened macOS Seatbelt Scheme profile.
 *
 * @param {import('./types.mjs').SandboxPolicy} policy
 * @returns {Promise<string>}
 */
export async function buildMacSeatbeltProfile(policy) {
  const root = await realpath(policy.projectRoot).catch(() => resolve(policy.projectRoot));
  const rootLiteral = JSON.stringify(root);
  const rawRoot = resolve(policy.projectRoot);
  const rawLiteral = JSON.stringify(rawRoot);

  const writeAllowClauses = [
    `(allow file-write* (literal ${rootLiteral}))`,
    `(allow file-write* (subpath ${rootLiteral}))`,
    '(allow file-write* (literal "/dev/null"))',
    '(allow file-write* (literal "/dev/zero"))',
    '(allow file-write* (literal "/dev/dtracehelper"))',
    '(allow file-write* (literal "/dev/tty"))',
  ];

  if (rawLiteral !== rootLiteral) {
    writeAllowClauses.push(
      `(allow file-write* (literal ${rawLiteral}))`,
      `(allow file-write* (subpath ${rawLiteral}))`
    );
  }

  if (Array.isArray(policy.scratchDirs)) {
    for (const dir of policy.scratchDirs) {
      if (typeof dir === 'string' && dir.trim()) {
        const resolved = await realpath(dir).catch(() => resolve(dir));
        const literal = JSON.stringify(resolved);
        writeAllowClauses.push(
          `(allow file-write* (literal ${literal}))`,
          `(allow file-write* (subpath ${literal}))`
        );
      }
    }
  }

  const sensitiveDenyClauses = [];
  {
    const userHome = homedir();
    for (const relPath of SENSITIVE_HOST_PATHS) {
      const fullPath = join(userHome, relPath);
      const literal = JSON.stringify(fullPath);
      sensitiveDenyClauses.push(
        `(deny file-read* (literal ${literal}))`,
        `(deny file-read* (subpath ${literal}))`
      );
    }
    for (const path of policy.protectedPaths ?? []) {
      const literal = JSON.stringify(await realpath(path).catch(() => resolve(path)));
      const exceptions = (policy.brokerJobDirs ?? []).map((dir) => `(require-not (subpath ${JSON.stringify(resolve(dir))}))`);
      const filter = exceptions.length ? `(require-all (subpath ${literal}) ${exceptions.join(' ')})` : `(subpath ${literal})`;
      sensitiveDenyClauses.push(`(deny file-read* ${filter})`, `(deny file-write* ${filter})`);
    }
    // These services can retrieve credentials without reading their files directly.
    sensitiveDenyClauses.push('(deny mach-lookup (global-name "com.apple.securityd"))', '(deny mach-lookup (global-name "com.apple.security.agent"))');
  }

  const networkClauses = [];
  if (policy.offline === true) {
    networkClauses.push(
      '(deny network*)',
      '(deny network-outbound)',
      '(deny network-inbound)'
    );
  }

  return [
    '(version 1)',
    '(allow default)',
    ';; Deny all file writes by default to prevent escaping the project root',
    '(deny file-write*)',
    '',
    ';; Allow writes strictly to workspace root, temp directories, and scratch dirs',
    ...writeAllowClauses,
    '',
    ';; Deny reading sensitive user credentials (~/.ssh, ~/.aws, keychains)',
    ...sensitiveDenyClauses,
    '',
    ';; Network controls',
    ...networkClauses,
  ].filter(Boolean).join('\n');
}

/**
 * Returns the spawn specification for executing a command via macOS Seatbelt.
 *
 * @param {string} command
 * @param {import('./types.mjs').SandboxPolicy} policy
 * @returns {Promise<{ command: string, args: string[], shell: boolean }>}
 */
export async function getMacSeatbeltSpawnSpec(command, policy) {
  const profile = await buildMacSeatbeltProfile(policy);
  return {
    command: '/usr/bin/sandbox-exec',
    args: ['-p', profile, '/bin/sh', '-c', command],
    shell: false,
  };
}
