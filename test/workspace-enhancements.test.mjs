import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listSessionEditedFiles } from '../src/runtime/session-edited-files.mjs';

function sessionHash(value) {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
}

test('edited files are derived from applied mutation journal state and deduplicated', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-edited-files-'));
  const sessionId = 'session_edited';
  try {
    const journalDir = join(dir, 'mutation-journal');
    await mkdir(journalDir, { recursive: true });
    await writeFile(join(journalDir, `${sessionHash(sessionId)}.json`), JSON.stringify({
      schema: 1,
      sessionId,
      entries: [
        { kind: 'file', state: 'applied', path: 'src/a.ts', tool: 'workspace_edit', createdAt: 10 },
        { kind: 'batch', state: 'applied', files: [{ path: 'src/b.ts' }, { path: 'src/a.ts' }], tool: 'tst_edit_batch', createdAt: 20 },
        { kind: 'barrier', state: 'applied', paths: ['package.json'], tool: 'bash', createdAt: 30 },
        { kind: 'file', state: 'undone', path: 'src/undone.ts', tool: 'workspace_write', createdAt: 40 },
        { kind: 'file', state: 'applied', path: '../escape.ts', tool: 'workspace_write', createdAt: 50 },
      ],
    }), 'utf8');

    const files = await listSessionEditedFiles(dir, sessionId);
    assert.deepEqual(files.map((file) => file.path), ['package.json', 'src/a.ts', 'src/b.ts']);
    assert.equal(files.find((file) => file.path === 'src/a.ts')?.tool, 'tst_edit_batch');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('workspace links stay behind the project-scoped main-process boundary', async () => {
  const [host, preload, markdown, enhancements, styles] = await Promise.all([
    readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/preload/preload.cjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/react/markdown.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/react/WorkspaceEnhancements.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/workspace-enhancements.css', import.meta.url), 'utf8'),
  ]);

  assert.match(host, /realpath\(project\.canonicalPath\)/);
  assert.match(host, /File path escapes the project workspace/);
  assert.match(host, /shell\.openPath\(actual\)/);
  assert.match(host, /shell\.openExternal\(url\.toString\(\)\)/);
  assert.match(host, /setWindowOpenHandler/);
  assert.match(preload, /openProjectFile:.*cuppet:native:open-project-file/s);
  assert.match(preload, /openExternal:.*cuppet:native:open-external/s);
  assert.match(preload, /editedFiles:.*cuppet:session:edited-files/s);
  assert.match(markdown, /data-cuppet-project-file/);
  assert.match(markdown, /data-cuppet-external/);
  assert.match(enhancements, /file\{files\.length === 1 \? '' : 's'\} edited/);
  assert.match(enhancements, /CODE_FILE/);
  assert.match(styles, /\.message\.user \.message-content\{[\s\S]*width:fit-content/);
});
