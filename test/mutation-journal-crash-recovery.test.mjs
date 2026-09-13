import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MutationJournal } from '../src/runtime/mutation-journal.mjs';

const sha256 = (value) => createHash('sha256').update(Buffer.from(value)).digest('hex');
const snapshot = (value) => ({ exists: true, hash: sha256(value), contentBase64: Buffer.from(value).toString('base64') });

async function fixture(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const projectRoot = join(dir, 'project');
  const journalDir = join(dir, 'journal');
  await mkdir(projectRoot, { recursive: true });
  return { dir, projectRoot, journalDir };
}

async function writePendingUndo(journalDir, token, files) {
  const pendingDir = join(journalDir, 'pending');
  await mkdir(pendingDir, { recursive: true });
  await writeFile(join(pendingDir, `${token.id}.json`), `${JSON.stringify({
    id: token.id,
    schema: 1,
    kind: 'undo-intent',
    sessionId: token.sessionId,
    executionId: token.executionId,
    tool: token.tool,
    projectRoot: token.projectRoot,
    files,
    createdAt: Date.now(),
  })}\n`);
}

test('unfinished multi-file batch is restored from durable pending intent after restart', async () => {
  const { dir, projectRoot, journalDir } = await fixture('cuppet-mutation-recovery-');
  try {
    await writeFile(join(projectRoot, 'a.txt'), 'before-a');
    await writeFile(join(projectRoot, 'b.txt'), 'before-b');

    const first = new MutationJournal(journalDir);
    await first.ready();
    await first.beginBatch({
      sessionId: 's1', executionId: 'exec1', projectRoot, paths: ['a.txt', 'b.txt'],
      expectedAfter: [
        { path: 'a.txt', exists: true, hash: sha256('after-a') },
        { path: 'b.txt', exists: true, hash: sha256('after-b') },
      ],
    });

    // Simulate a process crash after only the first atomic publication.
    await writeFile(join(projectRoot, 'a.txt'), 'after-a');

    const restarted = new MutationJournal(journalDir);
    const recovery = await restarted.ready();
    assert.equal(await readFile(join(projectRoot, 'a.txt'), 'utf8'), 'before-a');
    assert.equal(await readFile(join(projectRoot, 'b.txt'), 'utf8'), 'before-b');
    assert.equal(recovery.recoveredBatches, 1);
    assert.equal(recovery.restoredFiles, 1);
    assert.deepEqual(recovery.conflicts, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('restart recovery removes a partially-created file when its durable preimage says missing', async () => {
  const { dir, projectRoot, journalDir } = await fixture('cuppet-mutation-create-recovery-');
  try {
    const first = new MutationJournal(journalDir);
    await first.ready();
    await first.beginBatch({
      sessionId: 's1', executionId: 'exec-create', projectRoot, paths: ['new.txt'],
      expectedAfter: [{ path: 'new.txt', exists: true, hash: sha256('created') }],
    });
    await writeFile(join(projectRoot, 'new.txt'), 'created');

    const restarted = new MutationJournal(journalDir);
    const recovery = await restarted.ready();
    await assert.rejects(() => readFile(join(projectRoot, 'new.txt'), 'utf8'), (error) => error?.code === 'ENOENT');
    assert.equal(recovery.recoveredBatches, 1);
    assert.equal(recovery.restoredFiles, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('committed batch is never rolled back by restart recovery', async () => {
  const { dir, projectRoot, journalDir } = await fixture('cuppet-mutation-committed-');
  try {
    await writeFile(join(projectRoot, 'a.txt'), 'before');
    const first = new MutationJournal(journalDir);
    await first.ready();
    const token = await first.beginBatch({
      sessionId: 's1', executionId: 'exec2', projectRoot, paths: ['a.txt'],
      expectedAfter: [{ path: 'a.txt', exists: true, hash: sha256('after') }],
    });
    await writeFile(join(projectRoot, 'a.txt'), 'after');
    await first.commitBatch(token);

    const restarted = new MutationJournal(journalDir);
    const recovery = await restarted.ready();
    assert.equal(await readFile(join(projectRoot, 'a.txt'), 'utf8'), 'after');
    assert.equal(recovery.recoveredBatches, 0);
    assert.deepEqual(recovery.conflicts, []);
    const status = await restarted.status('s1');
    assert.equal(status.available, true);
    assert.equal(status.latest.id, token.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('recovery preserves unknown external edits and reports a conflict', async () => {
  const { dir, projectRoot, journalDir } = await fixture('cuppet-mutation-conflict-');
  try {
    await writeFile(join(projectRoot, 'a.txt'), 'before');
    const first = new MutationJournal(journalDir);
    await first.ready();
    await first.beginBatch({
      sessionId: 's1', executionId: 'exec3', projectRoot, paths: ['a.txt'],
      expectedAfter: [{ path: 'a.txt', exists: true, hash: sha256('cuppet-after') }],
    });

    // Neither the durable preimage nor Cuppet's expected postimage: treat as an
    // external/user edit and never overwrite it during automatic recovery.
    await writeFile(join(projectRoot, 'a.txt'), 'external-edit');

    const restarted = new MutationJournal(journalDir);
    const recovery = await restarted.ready();
    assert.equal(await readFile(join(projectRoot, 'a.txt'), 'utf8'), 'external-edit');
    assert.equal(recovery.recoveredBatches, 0);
    assert.equal(recovery.conflicts.length, 1);
    assert.equal(recovery.conflicts[0].path, 'a.txt');
    const status = await restarted.status('s1');
    assert.equal(status.recovery.conflicted, true);
    assert.equal(status.recovery.conflicts.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('restart completes a partially-applied multi-file undo from its durable intent', async () => {
  const { dir, projectRoot, journalDir } = await fixture('cuppet-undo-recovery-');
  try {
    await writeFile(join(projectRoot, 'a.txt'), 'before-a');
    await writeFile(join(projectRoot, 'b.txt'), 'before-b');
    const first = new MutationJournal(journalDir);
    await first.ready();
    const token = await first.beginBatch({
      sessionId: 's-undo', executionId: 'exec-undo', projectRoot, paths: ['a.txt', 'b.txt'],
      expectedAfter: [
        { path: 'a.txt', exists: true, hash: sha256('after-a') },
        { path: 'b.txt', exists: true, hash: sha256('after-b') },
      ],
    });
    await writeFile(join(projectRoot, 'a.txt'), 'after-a');
    await writeFile(join(projectRoot, 'b.txt'), 'after-b');
    await first.commitBatch(token);

    await writePendingUndo(journalDir, token, [
      { path: 'a.txt', before: token.files[0].before, after: snapshot('after-a') },
      { path: 'b.txt', before: token.files[1].before, after: snapshot('after-b') },
    ]);
    // Simulate a crash after the first file was restored but before the second.
    await writeFile(join(projectRoot, 'a.txt'), 'before-a');

    const restarted = new MutationJournal(journalDir);
    const recovery = await restarted.ready();
    assert.equal(await readFile(join(projectRoot, 'a.txt'), 'utf8'), 'before-a');
    assert.equal(await readFile(join(projectRoot, 'b.txt'), 'utf8'), 'before-b');
    assert.equal(recovery.restoredFiles, 1);
    assert.equal(recovery.recovered.length, 1);
    assert.equal(recovery.recovered[0].operation, 'undo');
    assert.equal(recovery.recovered[0].mutationId, token.id);
    assert.deepEqual(recovery.conflicts, []);
    const status = await restarted.status('s-undo');
    assert.equal(status.available, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('restart completes undo of a Cuppet-created file by removing the remaining postimage', async () => {
  const { dir, projectRoot, journalDir } = await fixture('cuppet-undo-created-file-');
  try {
    const first = new MutationJournal(journalDir);
    await first.ready();
    const token = await first.beginBatch({
      sessionId: 's-create-undo', executionId: 'exec-create-undo', projectRoot, paths: ['new.txt'],
      expectedAfter: [{ path: 'new.txt', exists: true, hash: sha256('created') }],
    });
    await writeFile(join(projectRoot, 'new.txt'), 'created');
    await first.commitBatch(token);
    await writePendingUndo(journalDir, token, [
      { path: 'new.txt', before: token.files[0].before, after: snapshot('created') },
    ]);

    const restarted = new MutationJournal(journalDir);
    const recovery = await restarted.ready();
    await assert.rejects(() => readFile(join(projectRoot, 'new.txt'), 'utf8'), (error) => error?.code === 'ENOENT');
    assert.equal(recovery.restoredFiles, 1);
    assert.equal(recovery.recovered[0].operation, 'undo');
    assert.equal((await restarted.status('s-create-undo')).available, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('undo recovery preserves an unknown external edit and blocks a second undo', async () => {
  const { dir, projectRoot, journalDir } = await fixture('cuppet-undo-conflict-');
  try {
    await writeFile(join(projectRoot, 'a.txt'), 'before');
    const first = new MutationJournal(journalDir);
    await first.ready();
    const token = await first.beginBatch({
      sessionId: 's-undo-conflict', executionId: 'exec-undo-conflict', projectRoot, paths: ['a.txt'],
      expectedAfter: [{ path: 'a.txt', exists: true, hash: sha256('after') }],
    });
    await writeFile(join(projectRoot, 'a.txt'), 'after');
    await first.commitBatch(token);
    await writePendingUndo(journalDir, token, [
      { path: 'a.txt', before: token.files[0].before, after: snapshot('after') },
    ]);
    await writeFile(join(projectRoot, 'a.txt'), 'external-edit');

    const restarted = new MutationJournal(journalDir);
    const recovery = await restarted.ready();
    assert.equal(await readFile(join(projectRoot, 'a.txt'), 'utf8'), 'external-edit');
    assert.equal(recovery.recovered.length, 0);
    assert.equal(recovery.conflicts.length, 1);
    assert.equal(recovery.conflicts[0].mutationId, token.id);
    assert.equal((await restarted.status('s-undo-conflict')).recovery.conflicted, true);
    await assert.rejects(
      () => restarted.undoLatest({ sessionId: 's-undo-conflict', projectRoot }),
      (error) => error?.code === 'undo_conflict' && /previous undo/i.test(error.message),
    );
    assert.equal(await readFile(join(projectRoot, 'a.txt'), 'utf8'), 'external-edit');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
