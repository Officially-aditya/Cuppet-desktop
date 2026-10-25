import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { ConversationDatabase } from '../src/runtime/database.mjs';
import { RuntimeService } from '../src/runtime/service.mjs';

const HISTORY = 'benchmark-history';
const HOME = 'benchmark-home';

export function seedChatSwitchFixture(db) {
  const dataUrl = 'data:image/png;base64,' + readFileSync(new URL('../src/renderer/assets/cuppet.png', import.meta.url)).toString('base64');
  db.transaction(() => {
    db.createSession({ id: HISTORY, title: 'Benchmark history', now: 1 });
    for (let sequence = 1; sequence <= 1000; sequence++) {
      const assistant = sequence % 2 === 0;
      const id = `${HISTORY}-m${sequence}`;
      db.appendMessage({ id, sessionId: HISTORY, role: assistant ? 'assistant' : 'user',
        content: assistant ? `## Answer ${sequence}\n\n${'Inspect **the change** in `src/app.ts` and verify the result.\n\n'.repeat(6)}` : `Question ${sequence}: please inspect the change.`,
        attachments: [995, 997, 999].includes(sequence) ? [{ name: `image-${sequence}.png`, mime: 'image/png', dataUrl }] : [], now: sequence + 1 });
      if (!assistant) continue;
      for (let index = 0; index < 20; index++) db.appendMessageActivity({ sessionId: HISTORY, messageId: id, now: sequence + 1,
        activity: index % 4 === 0
          ? { type: 'activity.tool.closed', callId: `${sequence}-${index}`, tool: 'read_file', status: 'success', details: 'Read src/app.ts' }
          : { type: 'activity.reasoning.delta', text: 'Inspecting the requested change.' } });
      db.createToolExecution({ id: `tool-${sequence}`, sessionId: HISTORY, messageId: id, callId: `${sequence}-0`, toolName: 'read_file', now: sequence + 1 });
      db.finishToolExecution(`tool-${sequence}`, { status: 'complete', output: 'Read src/app.ts', now: sequence + 1 });
    }
    db.createSession({ id: HOME, title: 'Benchmark home', now: 2000 });
    db.appendMessage({ id: `${HOME}-m1`, sessionId: HOME, role: 'user', content: 'Ready to switch.', now: 2001 });
  });
}

async function runtimeBenchmark() {
  const workspace = mkdtempSync(join(tmpdir(), 'cuppet-switch-benchmark-'));
  const databasePath = join(workspace, 'db.sqlite3');
  const db = new ConversationDatabase(databasePath);
  seedChatSwitchFixture(db);
  db.close();
  const runtime = new RuntimeService({ databasePath });
  try {
    const fetch = async () => {
      const start = performance.now();
      const payload = await runtime.handle('session.get', { sessionId: HISTORY, limit: 60 });
      const json = JSON.stringify(payload);
      JSON.parse(json);
      return { ms: performance.now() - start, bytes: Buffer.byteLength(json), messages: payload.messages.length, activities: payload.activities.length };
    };
    const cold = await fetch();
    const warm = [];
    for (let index = 0; index < 20; index++) warm.push((await fetch()).ms);
    warm.sort((a, b) => a - b);
    const result = { platform: process.platform, arch: process.arch, fixture: { messages: 1000, activities: 10000, images: 3 },
      payloadBytes: cold.bytes, windowMessages: cold.messages, windowActivities: cold.activities,
      coldReadMs: +cold.ms.toFixed(2), warmReadP95Ms: +warm[18].toFixed(2) };
    console.log('Chat-switch runtime benchmark: ' + JSON.stringify(result));
    assert.ok(cold.bytes < 250 * 1024, 'Initial session payload exceeds 250 KB');
    assert.ok(cold.ms < 250, 'Cold session read exceeds 250 ms');
    assert.ok(warm[18] < 100, 'Warm session reads exceed 100 ms');
  } finally { await runtime.close(); rmSync(workspace, { recursive: true, force: true }); }
}

async function rendererBenchmark() {
  const { app } = await import('electron');
  // The benchmark uses a disposable profile with no credentials or provider requests.
  app.commandLine.appendSwitch('use-mock-keychain');
  const profile = mkdtempSync(join(tmpdir(), 'cuppet-switch-renderer-'));
  app.setPath('userData', profile);
  const db = new ConversationDatabase(join(profile, 'runtime', 'conversations.sqlite3'));
  seedChatSwitchFixture(db);
  db.close();
  app.once('quit', () => { try { rmSync(profile, { recursive: true, force: true }); } catch {} });
  const timeout = setTimeout(() => { console.error('Chat-switch renderer benchmark timed out'); app.exit(1); }, 60_000);
  app.once('browser-window-created', (_event, window) => {
    window.webContents.setBackgroundThrottling(false);
    window.webContents.once('did-finish-load', async () => {
      try {
        window.show();
        window.focus();
        const result = await window.webContents.executeJavaScript(`(${async function () {
          const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
          const ready = async id => {
            for (let tries = 0; tries < 1000; tries++) {
              if (document.querySelector(`[data-message-id="${id}"]`) && !document.querySelector('.chat-loading-skeleton')) {
                const domReadyAt = performance.now();
                await frame(); await frame(); return domReadyAt;
              }
              await frame();
            }
            throw new Error('History did not become visible: ' + id);
          };
          await ready('benchmark-home-m1');
          const select = async (title, messageId) => {
            const button = [...document.querySelectorAll('.session-item')].find(node => node.textContent.includes(title));
            if (!button) throw new Error('Missing benchmark chat: ' + title);
            const start = performance.now();
            button.click();
            const domReadyAt = await ready(messageId);
            return { domMs: domReadyAt - start, paintMs: performance.now() - start };
          };
          const cold = await select('Benchmark history', 'benchmark-history-m1000');
          const warm = [];
          for (let index = 0; index < 5; index++) {
            await select('Benchmark home', 'benchmark-home-m1');
            warm.push(await select('Benchmark history', 'benchmark-history-m1000'));
          }
          const payload = await window.cuppet.sessions.get('benchmark-history', { limit: 60 });
          return { coldSwitchMs: cold.paintMs, coldDomMs: cold.domMs,
            warmSwitchMaxMs: Math.max(...warm.map(item => item.paintMs)), warmSwitchMs: warm,
            payloadBytes: new TextEncoder().encode(JSON.stringify(payload)).length,
            appMeasuresMs: performance.getEntriesByName('chat-switch').map(entry => entry.duration) };
        }.toString()})()`);
        console.log('Chat-switch renderer benchmark: ' + JSON.stringify({ platform: process.platform, arch: process.arch, ...result }));
        assert.ok(result.payloadBytes < 250 * 1024, 'Initial session payload exceeds 250 KB');
        assert.ok(result.coldSwitchMs < 250, 'Cold chat switch exceeds 250 ms');
        assert.ok(result.warmSwitchMaxMs < 100, 'Warm chat switch exceeds 100 ms');
        clearTimeout(timeout);
        app.quit();
      } catch (error) { console.error(error); clearTimeout(timeout); app.exit(1); }
    });
  });
  await import('../src/main/bootstrap.mjs');
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  if (process.versions.electron) await rendererBenchmark();
  else await runtimeBenchmark();
}
