import { posix, win32 } from 'node:path';

const BLOCKED = new Set([
  'exe', 'com', 'scr', 'pif', 'bat', 'cmd', 'msi', 'lnk', 'url', 'hta', 'cpl',
  'reg', 'inf', 'vbs', 'wsf', 'jar', 'ps1', 'app', 'command', 'pkg', 'dmg',
  'scpt', 'desktop', 'appimage', 'run', 'bin', 'deb', 'rpm', 'sh', 'bash', 'zsh',
]);
const WINDOWS_BLOCKED = new Set([
  'js', 'jse', 'py', 'pyw', 'pl', 'rb', 'msc', 'msix', 'appx', 'scf', 'vbe',
  'vb', 'wsh', 'ws', 'sct', 'psm1', 'psd1', 'msp', 'mst', 'application',
  'appref-ms', 'gadget', 'msixbundle', 'appxbundle',
]);
const DOCUMENTS_AND_SOURCE = new Set([
  'txt', 'md', 'mdx', 'markdown', 'rst', 'rtf', 'pdf', 'doc', 'docx', 'odt',
  'csv', 'tsv', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp', 'html', 'htm',
  'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'xml', 'ini', 'cfg', 'conf',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp', 'tiff',
  'mp3', 'mp4', 'wav', 'ogg', 'webm', 'mov',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'css', 'scss', 'less', 'vue', 'svelte',
  'py', 'pyw', 'pl', 'rb', 'go', 'rs', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs',
  'java', 'kt', 'swift', 'sql', 'graphql', 'proto', 'tex', 'ipynb', 'log',
]);

export function decideProjectFileOpen({ requested, actual, mode = 0, platform = process.platform }) {
  const windows = platform === 'win32';
  const paths = [requested, actual];
  const extensions = [];
  for (const path of paths) {
    if (typeof path !== 'string' || !path) return { allowed: false, reason: 'missing-path' };
    // A drive letter is not an alternate data stream. Check every other path component.
    const withoutDrive = path.replace(/^\\\\\?\\/, '').replace(/^[a-z]:[\\/]/i, '');
    if (windows && withoutDrive.includes(':')) return { allowed: false, reason: 'windows-alternate-stream' };
    const name = windows ? win32.basename(path).replace(/[. ]+$/, '') : posix.basename(path);
    const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
    if (BLOCKED.has(extension)) return { allowed: false, reason: 'blocked-extension' };
    if (windows && WINDOWS_BLOCKED.has(extension)) return { allowed: false, reason: 'windows-script' };
    extensions.push(extension);
  }
  if (!windows && (mode & 0o111) !== 0 && extensions.some(extension => !DOCUMENTS_AND_SOURCE.has(extension))) {
    return { allowed: false, reason: 'executable-file' };
  }
  return { allowed: true, reason: 'document' };
}
