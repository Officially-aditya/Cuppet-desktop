import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('Account Settings exposes only recoverable deleted chats and can restore them', async () => {
  const [runtime, main, preload, settings, types] = await Promise.all([
    source('src/runtime/main.mjs'),
    source('src/main/main.mjs'),
    source('src/preload/preload.cjs'),
    source('src/renderer/react/SettingsModal.tsx'),
    source('src/renderer/types.ts'),
  ]);

  assert.match(runtime, /case 'session\.deleted\.list'/);
  assert.match(runtime, /filter\(\(session\) => Number\(session\.deletedAt\) > 0/);
  assert.match(runtime, /DELETED_CHAT_RETENTION_MS/);
  assert.match(runtime, /purgeAt: Number\(session\.deletedAt\) \+ DELETED_CHAT_RETENTION_MS/);

  assert.match(main, /cuppet:session:deleted:list/);
  assert.match(main, /session\.deleted\.list/);
  assert.match(preload, /deleted: \(\) => ipcRenderer\.invoke\('cuppet:session:deleted:list'\)/);
  assert.match(types, /deleted: \(\) => Promise<Session\[\]>/);

  assert.match(settings, /<strong>Deleted chats<\/strong>/);
  assert.match(settings, /window\.cuppet\.sessions\.deleted\(\)/);
  assert.match(settings, /window\.cuppet\.sessions\.restore\(sessionId\)/);
  assert.match(settings, /recoverable for 7 days/);
  assert.match(settings, /No deleted chats in the 7-day recovery window\./);
});
