import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_CUPPET_UNIX_SOCKET_PATH_BYTES,
  createCuppetMcpBridgeEndpoint,
} from '../src/runtime/providers/transports/acp/cuppet-mcp-endpoint.mjs';

test('Darwin MCP bridge endpoint stays within sockaddr_un path budget', () => {
  const longDarwinTemp = `/var/folders/${'x'.repeat(120)}/T`;
  const endpoint = createCuppetMcpBridgeEndpoint({
    platform: 'darwin',
    pid: 4933,
    temporaryDirectory: longDarwinTemp,
    randomSuffix: '1369c7759b9f',
  });

  assert.equal(endpoint, '/tmp/cm-4933-1369c7759b9f.sock');
  assert.ok(Buffer.byteLength(endpoint) <= MAX_CUPPET_UNIX_SOCKET_PATH_BYTES);
});

test('POSIX endpoint keeps a short normal temp directory when it fits', () => {
  const endpoint = createCuppetMcpBridgeEndpoint({
    platform: 'linux',
    pid: 42,
    temporaryDirectory: '/tmp',
    randomSuffix: 'abcdef123456',
  });
  assert.equal(endpoint, '/tmp/cm-42-abcdef123456.sock');
});

test('Windows bridge endpoint remains a named pipe', () => {
  const endpoint = createCuppetMcpBridgeEndpoint({
    platform: 'win32',
    pid: 42,
    randomSuffix: 'abcdef123456',
  });
  assert.equal(endpoint, '\\\\.\\pipe\\cuppet-mcp-42-abcdef123456');
});
