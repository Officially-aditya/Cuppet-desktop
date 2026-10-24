// Run with: node benchmarks/streaming-activity.mjs
// Simulates ACP callbacks against the real database and runtime activity path.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ConversationDatabase } from '../src/runtime/database.mjs';
import { JournaledToolRuntime } from '../src/runtime/journaled-tool-runtime.mjs';
import { TurnStore } from '../src/runtime/turn-store.mjs';
import { RunWaitProjection } from '../src/runtime/run-wait-projection.mjs';

const chunks = 5000;
const dir = await mkdtemp(join(tmpdir(), 'cuppet-streaming-benchmark-'));
const db = new ConversationDatabase(join(dir, 'chat.sqlite3'));
const repository = db.sqlRepository();
const turns = new TurnStore(repository);
let phaseTransactions = 0;
const waits = new RunWaitProjection({
  exec: (sql) => repository.exec(sql), prepare: (sql) => repository.prepare(sql),
  transaction(callback) { phaseTransactions++; return repository.transaction(callback); },
});
db.createSession({ id: 's' });
db.appendMessage({ id: 'm', sessionId: 's', role: 'assistant', status: 'streaming' });
const events = [];
const emit = (event) => { waits.observe(event); events.push(event); };
const runtime = new JournaledToolRuntime({ db, journal: null, emit, tst: { configured: false } });
try {
  const start = performance.now();
  await runtime.run({
    sessionId: 's', messages: [],
    adapter: { async stream(_messages, options) {
      for (let i = 0; i < chunks; i++) await options.onActivity({ type: 'activity.reasoning.delta', text: 'r' });
      for (let i = 0; i < chunks; i++) {
        options.onDelta('word');
        await options.onActivity({ type: 'activity.text.delta', text: 'word' });
      }
      return { text: 'word'.repeat(chunks) };
    } },
    onDelta: async (delta) => {
      const message = db.appendMessageContent('m', delta);
      emit({ type: 'message.delta', sessionId: 's', messageId: 'm', delta, seq: message.content.length });
    },
  });
  emit({ type: 'message.completed', message: db.updateMessage('m', { status: 'complete' }) });
  emit({ type: 'run.finished', sessionId: 's', messageId: 'm' });
  turns.finishRun('m', { status: 'complete' });
  const elapsedMs = performance.now() - start;
  const readStart = performance.now();
  const session = db.getSession('s');
  const sessionReadMs = performance.now() - readStart;
  const sessionPayloadBytes = Buffer.byteLength(JSON.stringify(session));
  assert.equal(session.activities.length, 2, 'one reasoning batch and one text boundary');
  assert.equal(session.activities[0].activity.text, 'r'.repeat(chunks));
  assert.equal(session.messages[0].content, 'word'.repeat(chunks));
  assert.ok(events.length <= 8, 'chunk count must not multiply IPC events');
  assert.ok(sessionPayloadBytes < chunks * 5 + 10000, 'session payload must stay proportional to actual text');
  assert.equal(phaseTransactions, 1);
  console.log(JSON.stringify({ chunks, activityRows: session.activities.length, ipcEvents: events.length,
    ipcBytes: Buffer.byteLength(JSON.stringify(events)), sessionPayloadBytes, phaseTransactions,
    elapsedMs: Number(elapsedMs.toFixed(2)), sessionReadMs: Number(sessionReadMs.toFixed(2)) }, null, 2));
} finally {
  await runtime.close(); turns.close(); db.close(); await rm(dir, { recursive: true, force: true });
}
