import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ConversationDatabase } from '../src/runtime/database.mjs';
import { CommandReceiptStore } from '../src/runtime/command-receipts.mjs';
import { MutationJournal } from '../src/runtime/mutation-journal.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('runtime is independently executable without Electron or OpenCode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-process-'));
  const runtime = await startRuntime(dir);
  try {
    const response = await rpc(runtime, 'health-1', 'health');
    assert.equal(response.ok, true);
    assert.equal(response.result.runtime, 'independent');
  } finally {
    await stopRuntime(runtime);
    await rm(dir, { recursive: true, force: true });
  }
});

test('runtime receipt protection executes create, steer, and undo mutations at most once', { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-receipt-process-'));
  const workspace = join(dir, 'workspace');
  const trackedFile = join(workspace, 'receipt.txt');
  await mkdir(workspace, { recursive: true });
  await writeFile(trackedFile, 'zero\n');

  const runtime = await startRuntime(dir);
  try {
    const created = await rpc(runtime, 'create-once', 'session.create', {});
    assert.equal(created.ok, true);
    const createdAgain = await rpc(runtime, 'create-once', 'session.create', {});
    assert.equal(createdAgain.ok, true);
    assert.equal(createdAgain.result.id, created.result.id);

    const sessionsAfterReplay = await rpc(runtime, 'list-after-create', 'session.list', {});
    assert.equal(sessionsAfterReplay.ok, true);
    assert.equal(sessionsAfterReplay.result.length, 1);

    const conflict = await rpc(runtime, 'create-once', 'session.create', { projectId: 'different-project' });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, 'COMMAND_RECEIPT_CONFLICT');

    const steered = await rpc(runtime, 'steer-once', 'session.steer', {
      sessionId: created.result.id,
      text: 'one steering message',
    });
    assert.equal(steered.ok, true);
    const steeredAgain = await rpc(runtime, 'steer-once', 'session.steer', {
      sessionId: created.result.id,
      text: 'one steering message',
    });
    assert.equal(steeredAgain.ok, true);
    assert.deepEqual(steeredAgain.result, steered.result);

    const steeredSession = await rpc(runtime, 'get-after-steer', 'session.get', { sessionId: created.result.id });
    assert.equal(steeredSession.ok, true);
    assert.equal(steeredSession.result.messages.filter((message) => message.role === 'user' && message.content === 'one steering message').length, 1);
    assert.equal(steeredSession.result.messages.filter((message) => message.role === 'assistant').length, 1);

    const projectResponse = await rpc(runtime, 'project-add', 'project.add-local', { path: workspace, name: 'Receipt project' });
    assert.equal(projectResponse.ok, true);
    const projectSession = await rpc(runtime, 'create-project-session', 'session.create', { projectId: projectResponse.result.id });
    assert.equal(projectSession.ok, true);

    const journal = new MutationJournal(join(dir, 'mutation-journal'));
    await journal.ready();
    const firstMutation = await journal.beginFile({
      sessionId: projectSession.result.id,
      executionId: 'exec-receipt-a',
      tool: 'receipt-test',
      projectRoot: workspace,
      path: 'receipt.txt',
    });
    await writeFile(trackedFile, 'one\n');
    await journal.commitFile(firstMutation);

    const secondMutation = await journal.beginFile({
      sessionId: projectSession.result.id,
      executionId: 'exec-receipt-b',
      tool: 'receipt-test',
      projectRoot: workspace,
      path: 'receipt.txt',
    });
    await writeFile(trackedFile, 'two\n');
    await journal.commitFile(secondMutation);

    const undone = await rpc(runtime, 'undo-once', 'session.undo', { sessionId: projectSession.result.id });
    assert.equal(undone.ok, true);
    assert.equal(undone.result.undone, true);
    assert.equal(await readFile(trackedFile, 'utf8'), 'one\n');

    const undoneAgain = await rpc(runtime, 'undo-once', 'session.undo', { sessionId: projectSession.result.id });
    assert.equal(undoneAgain.ok, true);
    assert.deepEqual(undoneAgain.result, undone.result);
    assert.equal(await readFile(trackedFile, 'utf8'), 'one\n');
  } finally {
    await stopRuntime(runtime);
    await rm(dir, { recursive: true, force: true });
  }
});

test('runtime restart turns an interrupted mutation receipt unknown and never redispatches it', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-receipt-restart-'));
  let runtime = await startRuntime(dir);
  try {
    const baseline = await rpc(runtime, 'baseline-create', 'session.create', {});
    assert.equal(baseline.ok, true);
    await stopRuntime(runtime);

    const db = new ConversationDatabase(join(dir, 'conversations.sqlite3'));
    try {
      const receipts = new CommandReceiptStore(db.sqlRepository());
      const begun = receipts.begin({ commandId: 'crashed-create', method: 'session.create', params: {} });
      assert.equal(begun.created, true);
      assert.equal(begun.receipt.state, 'processing');
    } finally {
      db.close();
    }

    runtime = await startRuntime(dir);
    const retry = await rpc(runtime, 'crashed-create', 'session.create', {});
    assert.equal(retry.ok, false);
    assert.equal(retry.code, 'COMMAND_OUTCOME_UNKNOWN');

    const sessions = await rpc(runtime, 'list-after-unknown', 'session.list', {});
    assert.equal(sessions.ok, true);
    assert.equal(sessions.result.length, 1);
    assert.equal(sessions.result[0].id, baseline.result.id);
  } finally {
    await stopRuntime(runtime);
    await rm(dir, { recursive: true, force: true });
  }
});

async function startRuntime(dir) {
  const child = spawn(process.execPath, [join(here, '..', 'src', 'runtime', 'main.mjs')], {
    env: { ...process.env, CUPPET_DATA_DIR: dir, CUPPET_NONINTERACTIVE: '1', CUPPET_PE3: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const messages = [];
  lines.on('line', (line) => messages.push(JSON.parse(line)));
  const runtime = { child, lines, messages };
  await waitUntil(() => messages.some((message) => message.kind === 'event' && message.event?.type === 'runtime.ready'), 5000);
  return runtime;
}

async function rpc(runtime, id, method, params = {}) {
  const start = runtime.messages.length;
  runtime.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  await waitUntil(
    () => runtime.messages.slice(start).some((message) => message.kind === 'response' && message.id === id),
    5000,
  );
  return runtime.messages.slice(start).find((message) => message.kind === 'response' && message.id === id);
}

async function stopRuntime(runtime) {
  if (!runtime?.child || runtime.child.exitCode !== null) return;
  runtime.child.stdin.end();
  const exited = Promise.race([
    once(runtime.child, 'exit').then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
  ]);
  if (!await exited && runtime.child.exitCode === null) {
    runtime.child.kill('SIGTERM');
    await Promise.race([
      once(runtime.child, 'exit'),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
  }
  runtime.lines.close();
}

async function waitUntil(predicate, timeout = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
