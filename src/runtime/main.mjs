import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { RuntimeService } from './service.mjs';

const dataDir = process.env.CUPPET_DATA_DIR || join(homedir(), '.cuppet-desktop');
const databasePath = join(dataDir, 'conversations.sqlite3');

const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const service = new RuntimeService({
  databasePath,
  emit: (event) => write({ kind: 'event', event }),
});

write({ kind: 'event', event: { type: 'runtime.ready', databasePath } });

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', async (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
    if (!request || typeof request !== 'object' || typeof request.id !== 'string' || typeof request.method !== 'string') {
      throw new Error('invalid runtime request');
    }
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

let closed = false;
function shutdown() {
  if (closed) return;
  closed = true;
  service.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.stdin.on('end', shutdown);
