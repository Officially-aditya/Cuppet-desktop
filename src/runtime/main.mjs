import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { RuntimeService } from './service.mjs';

const dataDir = process.env.CUPPET_DATA_DIR || join(homedir(), '.cuppet-desktop');
const databasePath = join(dataDir, 'conversations.sqlite3');

const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const service = new RuntimeService({
  databasePath,
  dataDir,
  emit: (event) => write({ kind: 'event', event }),
});

write({ kind: 'event', event: { type: 'runtime.ready', databasePath } });

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', async (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
    if (!request || typeof request !== 'object' || typeof request.id !== 'string' || typeof request.method !== 'string') throw new Error('invalid runtime request');
  } catch (error) {
    write({ kind: 'protocol-error', error: error instanceof Error ? error.message : String(error) });
    return;
  }
  try {
    const result = await service.handle(request.method, request.params ?? {});
    write({ kind: 'response', id: request.id, ok: true, result });
  } catch (error) {
    write({ kind: 'response', id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

let closing;
async function shutdown() {
  if (closing) return closing;
  closing = service.close().catch(() => undefined).finally(() => process.exit(0));
  return closing;
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
process.stdin.on('end', () => void shutdown());
