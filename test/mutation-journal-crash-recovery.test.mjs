import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MutationJournal } from '../src/runtime/mutation-journal.mjs';

const sha256 = (value) => createHash('sha256').update(Buffer.from(value)).digest('hex');

async function fixture(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const projectRoot = join(dir, 'project');
  const journalDir = join(dir, 'journal');
  await mkdir(projectRoot, { recursive: true });
  return { dir, projectRoot, journalDir };
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
