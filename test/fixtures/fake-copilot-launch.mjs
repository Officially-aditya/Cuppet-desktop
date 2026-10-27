import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const modern = process.env.TEST_COPILOT_FLAVOR !== 'legacy';
if (process.argv.includes('--help')) {
  console.log(modern ? '--acp --server --sync-session[=on|off]' : '--acp --server --no-remote --no-remote-export');
  process.exit(0);
}
if (process.argv.includes('--version')) { console.log(modern ? '1.0.103' : '1.0.102'); process.exit(0); }
if (process.env.ELECTRON_RUN_AS_NODE) throw new Error('Electron environment leaked');
if (process.env.TEST_COPILOT_FAIL) { console.error('Copilot launch diagnostic: incompatible option'); process.exit(1); }
if (modern && (process.argv.includes('--no-remote') || process.argv.includes('--no-remote-export'))) throw new Error('--no-remote was removed');
if (!modern && process.argv.some(arg => arg.startsWith('--sync-session'))) throw new Error('Unknown option: --sync-session');
if (!process.argv.includes(modern ? '--sync-session=off' : '--no-remote-export')) throw new Error('Session syncing was not disabled');

if (process.argv.includes('--server')) {
  let input = Buffer.alloc(0);
  process.stdin.on('data', chunk => {
    input = Buffer.concat([input, chunk]);
    while (true) {
      const boundary = input.indexOf('\r\n\r\n');
      if (boundary < 0) break;
      const length = Number(input.subarray(0, boundary).toString().match(/Content-Length: (\d+)/)?.[1]);
      if (input.length < boundary + 4 + length) break;
      const message = JSON.parse(input.subarray(boundary + 4, boundary + 4 + length));
      input = input.subarray(boundary + 4 + length);
      if (message.method !== 'session.delete') throw new Error('Unexpected cleanup method');
      appendFileSync(process.env.TEST_COPILOT_LOG, message.params.sessionId + '\n');
      const body = JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { success: true } });
      process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    }
  });
} else {
  let cold = false;
  if (process.env.TEST_COPILOT_COLD_FILE) {
    const path = process.env.TEST_COPILOT_COLD_FILE;
    const count = existsSync(path) ? Number(readFileSync(path, 'utf8')) : 0;
    writeFileSync(path, String(count + 1));
    cold = count === 0;
  }
  createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line);
    if (message.method !== 'initialize') throw new Error('Only a read-only handshake is expected');
    if (cold) return;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } }) + '\n');
  });
}
