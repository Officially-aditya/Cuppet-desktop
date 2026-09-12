import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Darwin sockaddr_un.sun_path is only 104 bytes including termination.
// Keep a little headroom so the bridge works from long /var/folders/... temp roots.
export const MAX_CUPPET_UNIX_SOCKET_PATH_BYTES = 100;

export function createCuppetMcpBridgeEndpoint({
  platform = process.platform,
  pid = process.pid,
  temporaryDirectory = tmpdir(),
  randomSuffix = randomBytes(6).toString('hex'),
} = {}) {
  const safePid = String(pid).replace(/[^0-9]/g, '').slice(0, 12) || '0';
  const safeSuffix = String(randomSuffix).replace(/[^A-Za-z0-9]/g, '').slice(0, 16) || randomBytes(6).toString('hex');

  if (platform === 'win32') {
    return `\\\\.\\pipe\\cuppet-mcp-${safePid}-${safeSuffix}`;
  }

  // Keep the filename deliberately short. macOS temp directories are normally
  // nested under /var/folders and a UUID-sized filename can exceed sun_path.
  const filename = `cm-${safePid}-${safeSuffix}.sock`;
  const preferred = join(String(temporaryDirectory || '/tmp'), filename);
  if (Buffer.byteLength(preferred) <= MAX_CUPPET_UNIX_SOCKET_PATH_BYTES) return preferred;

  const fallback = join('/tmp', filename);
  if (Buffer.byteLength(fallback) > MAX_CUPPET_UNIX_SOCKET_PATH_BYTES) {
    throw new Error('Unable to create a Darwin-safe Cuppet MCP bridge socket path.');
  }
  return fallback;
}
