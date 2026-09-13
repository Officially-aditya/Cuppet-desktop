import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { ConversationDatabase } from '../src/runtime/database.mjs';
import { RuntimeService } from '../src/runtime/service.mjs';

test('RuntimeService borrows a host-owned ConversationDatabase without closing it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-runtime-db-owner-'));
  const path = join(dir, 'conversations.sqlite3');
  const db = new ConversationDatabase(path);
  const tst = {
    configured: false,
    status: { configured: false, connected: false },
    close() {},
  };
  const toolRuntime = {
    close: async () => {},
    forgetSession: async () => false,
  };

  try {
    const service = new RuntimeService({
      database: db,
      databasePath: path,
      dataDir: dir,
      tst,
      toolRuntime,
      interactive: false,
    });

    const created = service.createSession();
    assert.equal(db.getSessionSummary(created.id)?.id, created.id);

    await service.close();

    const hostWrite = db.createSession({ id: 'session_after_service_close' });
    assert.equal(hostWrite.id, 'session_after_service_close');
    assert.equal(db.getSessionSummary(hostWrite.id)?.id, hostWrite.id);
  } finally {
    try { db.close(); } catch {}
    await rm(dir, { recursive: true, force: true });
  }
});

test('runtime main keeps one physical conversation database owner and injects its receipt-aware view into RuntimeService', async () => {
  const source = await readFile(new URL('../src/runtime/main.mjs', import.meta.url), 'utf8');
  const physicalOwners = source.match(/new ConversationDatabase\(databasePath\)/g) ?? [];
  const runtimeServiceConfig = source.match(/const runtimeService = new RuntimeService\(\{([\s\S]*?)\}\);/)?.[1] ?? '';

  assert.equal(physicalOwners.length, 1, 'runtime main must create exactly one physical ConversationDatabase');
  assert.match(source, /const localState = new ConversationDatabase\(databasePath\)/);
  assert.match(source, /const receiptDatabase = new CommandReceiptDatabaseFacade\(localState, commandReceipts\)/);
  assert.match(runtimeServiceConfig, /\bdatabase:\s*receiptDatabase\.database\b/, 'RuntimeService must borrow the receipt-aware host database view');
  assert.match(runtimeServiceConfig, /(?:^|,)\s*runState\s*(?:,|$)/, 'RuntimeService must receive the durable run-state authority');
  assert.doesNotMatch(runtimeServiceConfig, /new ConversationDatabase/, 'RuntimeService construction must not create a second physical database owner');
});
