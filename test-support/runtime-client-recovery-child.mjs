import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const dataDir = process.env.CUPPET_DATA_DIR;
const sendMarker = join(dataDir, 'fixture-send-seen');
let hangHealth = false;

write({ kind: 'event', event: { type: 'runtime.ready', databasePath: join(dataDir, 'fixture.sqlite3') } });

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', async (line) => {
  const request = JSON.parse(line);
  if (request.method === 'health') {
    if (!hangHealth) respond(request.id, { ok: true, runtime: 'recovery-fixture' });
    return;
  }
  if (request.method === 'arm-hang') {
    hangHealth = true;
    respond(request.id, { armed: true });
    return;
  }
  if (request.method === 'session.get') {
    respond(request.id, { id: request.params?.sessionId ?? null, title: 'Recovered chat' });
    return;
  }
  if (request.method === 'session.send') {
    const priorId = await markerId(sendMarker);
    if (priorId) {
      if (priorId !== request.id) {
        respondError(request.id, 'durable session.send was retried with a different command id');
        return;
      }
      respond(request.id, { replayed: true, sameCommandId: true });
      return;
    }
    await writeFile(sendMarker, request.id, 'utf8');
    setTimeout(() => process.exit(23), 5);
    return;
  }
  respondError(request.id, 'unknown method');
});

process.stdin.on('end', () => setTimeout(() => process.exit(0), 10));

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function respond(id, result) {
  write({ kind: 'response', id, ok: true, result });
}

function respondError(id, error) {
  write({ kind: 'response', id, ok: false, error });
}

async function markerId(path) {
  try {
    const value = (await readFile(path, 'utf8')).trim();
    return value || null;
  } catch {
    return null;
  }
}
