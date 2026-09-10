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

test('edited file events preserve repeated edits across turns while excluding undone and unsafe paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-edited-files-'));
  const sessionId = 'session_edited';
  try {
    const journalDir = join(dir, 'mutation-journal');
    await mkdir(journalDir, { recursive: true });
    await writeFile(join(journalDir, `${sessionHash(sessionId)}.json`), JSON.stringify({
      schema: 1,
      sessionId,
      entries: [
        { id: 'm1', executionId: 'e1', kind: 'file', state: 'applied', path: 'src/a.ts', tool: 'workspace_edit', createdAt: 10 },
        { id: 'm2', executionId: 'e2', kind: 'batch', state: 'applied', files: [{ path: 'src/b.ts' }, { path: 'src/a.ts' }], tool: 'tst_edit_batch', createdAt: 20 },
        { id: 'm3', executionId: 'e3', kind: 'barrier', state: 'applied', paths: ['package.json'], tool: 'bash', createdAt: 30 },
        { id: 'm4', executionId: 'e4', kind: 'file', state: 'undone', path: 'src/undone.ts', tool: 'workspace_write', createdAt: 40 },
        { id: 'm5', executionId: 'e5', kind: 'file', state: 'applied', path: '../escape.ts', tool: 'workspace_write', createdAt: 50 },
      ],
    }), 'utf8');

    const files = await listSessionEditedFiles(dir, sessionId);
    assert.deepEqual(files.map((file) => file.path), ['src/a.ts', 'src/a.ts', 'src/b.ts', 'package.json']);
    assert.deepEqual(files.filter((file) => file.path === 'src/a.ts').map((file) => file.mutationId), ['m1', 'm2']);
    assert.equal(files.some((file) => file.path === 'src/undone.ts'), false);
    assert.equal(files.some((file) => file.path === '../escape.ts'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('workspace links, turn-scoped edited files, dynamic user messages, and working state stay behind their intended surfaces', async () => {
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
  assert.match(enhancements, /groupEditedFilesByTurn/);
  assert.match(enhancements, /owner\.status === 'streaming'/);
  assert.match(enhancements, /data-cuppet-edited-files-summary/);
  assert.doesNotMatch(enhancements, /react-composer-wrap|workspace-edited-files-mount|createPortal/);
  assert.match(enhancements, /CODE_FILE/);
  assert.match(styles, /\.message\.user \.message-content\{[\s\S]*width:fit-content/);
  assert.match(styles, /content:'Working…'/);
  assert.match(styles, /:has\(\.composer-pause-button\)/);
  assert.doesNotMatch(styles, /workspace-edited-files-mount/);
});
