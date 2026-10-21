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

test('workspace links, edited files, working state, and reasoning stay on canonical ownership paths', async () => {
  const [host, runtime, preload, markdown, projectLinks, chatPane, chatView, clientTranscript, chatTranscript, styles, filePaths] = await Promise.all([
    readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/runtime/main.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/preload/preload.cjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/react/markdown.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/react/project-links.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/react/ChatPane.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/react/ChatTranscript.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/react/client-transcript.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/react/chat-transcript.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/workspace-enhancements.css', import.meta.url), 'utf8').then((css) => css.replace(/\s*([{}:;,])\s*/g, '$1')),
    readFile(new URL('../src/main/project-file-path.mjs', import.meta.url), 'utf8'),
  ]);

  assert.match(host, /realpath\(project\.canonicalPath\)/);
  assert.match(host, /resolveProjectFilePath\(root, path\)/);
  assert.match(filePaths, /File path escapes the project workspace/);
  assert.match(host, /shell\.openPath\(actual\)/);
  assert.match(host, /shell\.openExternal\(url\.toString\(\)\)/);
  assert.match(host, /setWindowOpenHandler/);
  assert.match(host, /cuppet:session:edited-files'[\s\S]*request\('session\.edited-files'/);
  assert.doesNotMatch(host, /listSessionEditedFiles|mutation-journal/);
  assert.match(runtime, /listSessionEditedFiles/);
  assert.match(runtime, /case 'session\.edited-files'/);
  assert.match(runtime, /listSessionEditedFiles\(dataDir, sessionId\)/);
  assert.match(preload, /openProjectFile:.*cuppet:native:open-project-file/s);
  assert.match(preload, /openExternal:.*cuppet:native:open-external/s);
  assert.match(preload, /editedFiles:.*cuppet:session:edited-files/s);
  assert.match(markdown, /data-cuppet-project-file/);
  assert.match(markdown, /data-cuppet-external/);
  // Inline file paths are linked by the renderer at render time and opened by React handlers; nothing patches
  // React-owned DOM after the fact (UI-07, UI-08).
  assert.match(markdown, /CODE_FILE/);
  assert.match(markdown, /export function inlineProjectPath/);
  assert.match(projectLinks, /export function openChatLink/);
  assert.doesNotMatch(projectLinks, /MutationObserver|querySelector|react-composer-wrap|workspace-edited-files-mount|createPortal/);
  assert.doesNotMatch(projectLinks, /message\.reasoning|data-cuppet-visible-reasoning|readStoredReasoning|TRACE_KEY_PREFIX|LEGACY_REASONING_KEY_PREFIX|liveReasoning|message-visible-reasoning/);
  assert.match(chatView, /openChatLink\(projectId, event\.target\)/);
  assert.match(chatPane, /<ChatLinkPreview projectId=\{linkProjectId\} \/>/);
  assert.doesNotMatch(chatPane, /MutationObserver/);
  await assert.rejects(readFile(new URL('../src/renderer/react/WorkspaceEnhancements.tsx', import.meta.url), 'utf8'), { code: 'ENOENT' });
  await assert.rejects(readFile(new URL('../src/renderer/react/CommandResultEnhancement.tsx', import.meta.url), 'utf8'), { code: 'ENOENT' });
  const entry = await readFile(new URL('../src/renderer/main.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(entry, /WorkspaceEnhancements|CommandResultEnhancement/);
  assert.match(clientTranscript, /SUPPORTED_EVENT_TYPES[\s\S]*runtime\.activity/);
  assert.match(clientTranscript, /reduceTranscriptEvent\(current, \{ \.\.\.event, messageId \}\)/);
  assert.match(chatTranscript, /event\.type !== 'runtime\.activity'/);
  assert.match(chatTranscript, /activityType === 'activity\.reasoning\.delta'/);
  assert.match(chatPane, /const transcript = useClientTranscript\(session\)/);
  assert.match(chatView, /message-reasoning-content markdown-rendered/);
  assert.match(chatView, /items=\{transcript\[message\.id\]\?\.items\}/);
  assert.match(chatView, /return orderedTranscriptItems\(items\)/);
  assert.match(styles, /\.message\.user \.message-content\{[\s\S]*width:fit-content/);
  assert.match(styles, /content:'Working…'/);
  assert.match(styles, /:has\(\.composer-pause-button\)/);
  assert.match(styles, /\.message-trace-reasoning\{/);
  assert.doesNotMatch(styles, /message-trace-reasoning\{display:none|message-visible-reasoning/);
  assert.doesNotMatch(styles, /workspace-edited-files-mount/);
});
