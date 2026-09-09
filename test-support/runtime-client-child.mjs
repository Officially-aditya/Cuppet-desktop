import { createInterface } from 'node:readline';

process.stdout.write(`${JSON.stringify({ kind: 'event', event: { type: 'runtime.ready', databasePath: `${process.env.CUPPET_DATA_DIR}/fixture.sqlite3` } })}\n`);

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'health') process.stdout.write(`${JSON.stringify({ kind: 'response', id: request.id, ok: true, result: { ok: true, runtime: 'fixture' } })}\n`);
  else process.stdout.write(`${JSON.stringify({ kind: 'response', id: request.id, ok: false, error: 'unknown method' })}\n`);
});
process.stdin.on('end', () => setTimeout(() => process.exit(0), 10));
