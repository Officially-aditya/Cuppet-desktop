import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [index, navigation, preload, main, runtimeMain] = await Promise.all([
  readFile(new URL('../src/renderer/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../src/renderer/d1-navigation.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/preload/preload.cjs', import.meta.url), 'utf8'),
  readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../src/runtime/main.mjs', import.meta.url), 'utf8'),
]);

test('Search is visible and execution/Markdown renderer is actually loaded', () => {
  assert.match(index, /id="search-button" class="nav-button">Search/);
  assert.doesNotMatch(index, /id="search-button"[^>]*disabled/);
  assert.match(index, /d1-navigation\.js/);
  assert.match(index, /type="module" src="execution-ui\.mjs"/);
});

test('renderer provides search navigation, lifecycle actions, and scroll preservation', () => {
  assert.match(navigation, /sessions\.search/);
  assert.match(navigation, /sessions\.rename/);
  assert.match(navigation, /sessions\.archive/);
  assert.match(navigation, /sessions\.restore/);
  assert.match(navigation, /sessions\.delete/);
  assert.match(navigation, /projects\.rename/);
  assert.match(navigation, /cuppet\.desktop\.last-session/);
  assert.match(navigation, /cuppet\.desktop\.scroll\./);
  assert.match(navigation, /stickyToBottom/);
  assert.match(navigation, /search-hit/);
  assert.match(navigation, /metaKey \|\| event\.ctrlKey/);
});

test('IPC and runtime host keep lifecycle/search outside renderer authority', () => {
  for (const channel of ['session:search','session:rename','session:archive','session:restore','session:delete','project:rename']) {
    assert.ok(preload.includes(`cuppet:${channel}`), `preload missing ${channel}`);
    assert.ok(main.includes(`cuppet:${channel}`), `main IPC missing ${channel}`);
  }
  for (const method of ['session.search','session.rename','session.archive','session.restore','session.delete','project.rename']) {
    assert.ok(runtimeMain.includes(`case '${method}'`), `runtime host missing ${method}`);
  }
  assert.match(runtimeMain, /cannot \$\{action\} a chat while it is generating/);
  assert.match(runtimeMain, /cannot \$\{action\} a chat while it has queued messages/);
});
