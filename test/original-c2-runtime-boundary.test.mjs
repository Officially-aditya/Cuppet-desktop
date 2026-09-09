import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeService } from '../src/runtime/service.mjs';
import { executeCommand, parseSlashCommand } from '../src/runtime/commands.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function backgroundFactory() {
  return () => ({
    stats: { queued: 0, runs: 0 },
    async ready() {}, async close() {}, async recordTurn() {}, async flushNow() { return { status: 'empty' }; },
    foregroundStarted() {}, foregroundIdle() {}, setProviderConfig() {}, pause() {}, resume() {},
  });
}

test('recognized and unknown slash commands fail before provider creation and do not enter the transcript', async () => {
  const previousPe3 = process.env.CUPPET_PE3;
  process.env.CUPPET_PE3 = '0';
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-original-c2-boundary-'));
  let providerCreations = 0;
  const service = new RuntimeService({
    databasePath: join(dir, 'db.sqlite3'),
    dataDir: join(dir, 'runtime'),
    providerFactory: () => {
      providerCreations++;
      return { async stream() { return { text: 'ok', toolCalls: [] }; } };
    },
    toolRuntime: {
      async run({ onDelta }) { await onDelta('ok'); return { text: 'ok' }; },
    },
    backgroundFactory: backgroundFactory(),
  });

  try {
    const session = await service.handle('session.create', {});
    const before = await service.handle('session.get', { sessionId: session.id });
    assert.equal(before.messages.length, 0);

    await assert.rejects(
      () => service.handle('session.send', { sessionId: session.id, text: '/status', provider: { model: 'm' } }),
      /must be executed through the command registry/,
    );
    await assert.rejects(
      () => service.handle('session.send', { sessionId: session.id, text: '/definitely-unknown', provider: { model: 'm' } }),
      /Unknown Cuppet command/,
    );
    assert.equal(providerCreations, 0);
    assert.equal((await service.handle('session.get', { sessionId: session.id })).messages.length, 0);

    const command = await executeCommand(parseSlashCommand('/plan status'), {
      sessionId: session.id,
      call: (method, params) => service.handle(method, params),
      host: {}, provider: {}, providerRequest: {},
    });
    assert.equal(command.result.mode, 'build');
    assert.equal((await service.handle('session.get', { sessionId: session.id })).messages.length, 0);

    await service.handle('session.send', { sessionId: session.id, text: 'ordinary prompt', provider: { model: 'm' } });
    for (let i = 0; i < 100 && providerCreations === 0; i++) await sleep(5);
    assert.equal(providerCreations, 1);
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
    if (previousPe3 === undefined) delete process.env.CUPPET_PE3; else process.env.CUPPET_PE3 = previousPe3;
  }
});
