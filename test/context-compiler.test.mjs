import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ContextCompiler } from '../src/runtime/context-compiler.mjs';

const execFileAsync = promisify(execFile);

async function gitProject(t) {
  const root = await mkdtemp(join(tmpdir(), 'cuppet-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileAsync('git', ['-c', 'user.name=Cuppet Tests', '-c', 'user.email=cuppet-tests@example.invalid', '-c', 'commit.gpgSign=false', ...args], { cwd: root });
  await git('init', '--quiet');
  return { root, git };
}

function state({ mode = 'build', orchestrator = false } = {}) {
  return { mode: () => mode, snapshot: () => ({ orchestratorEnabled: orchestrator }) };
}

function fakeTst(prepared) {
  const calls = [];
  let completions = 0;
  return {
    configured: true,
    status: { configured: true, connected: true, protocol: 'cuppet.tst.v3' },
    calls,
    get completions() { return completions; },
    async prepareContext(...args) { calls.push(args); return structuredClone(prepared); },
    async turnCompleted() { completions += 1; },
    async refreshStm() { return { records: [{ key: 'goal', value: 'keep context deterministic' }] }; },
  };
}

test('compiler injects detached cache-stable context without mutating durable messages', async () => {
  const tst = fakeTst({ observation_complete: true, stm: [{ key: 'goal', value: 'preserve transcript' }], ltm: [{ key: 'style', value: 'use runtime truth' }], graph: [{ node: { path: 'src/runtime/service.mjs', name: 'RuntimeService' } }] });
  const compiler = new ContextCompiler({ tst, cognitiveState: state() });
  const durable = [{ id: 'u1', role: 'user', content: 'Update src/runtime/service.mjs' }];
  const before = structuredClone(durable);
  const first = await compiler.compile({ sessionId: 's1', messages: durable, userMessageId: 'u1', usableTokens: 100000 });
  const second = await compiler.compile({ sessionId: 's1', messages: durable, userMessageId: 'u1', usableTokens: 100000 });
  assert.deepEqual(durable, before);
  assert.equal(first.injected, true);
  assert.equal(first.budgetTokens, 2048);
  assert.equal(first.messages.find((m) => m.role === 'system')?.content, second.messages.find((m) => m.role === 'system')?.content);
  assert.equal(tst.calls.length, 1, 'same user epoch must not rebuild context');
  assert.equal(tst.completions, 0, 'context compilation must never own terminal turn completion');
  assert.match(first.messages.find((m) => m.role === 'system').content, /trust="untrusted"/);
});

test('a later user epoch does not complete the previous TST turn', async () => {
  const tst = fakeTst({ observation_complete: true, stm: [{ key: 'goal', value: 'preserve terminal ownership' }] });
  const compiler = new ContextCompiler({ tst, cognitiveState: state() });
  await compiler.compile({ sessionId: 's-terminal', messages: [{ id: 'u1', role: 'user', content: 'First turn' }], userMessageId: 'u1' });
  await compiler.compile({ sessionId: 's-terminal', messages: [{ id: 'u1', role: 'user', content: 'First turn' }, { id: 'a1', role: 'assistant', content: 'done' }, { id: 'u2', role: 'user', content: 'Second turn' }], userMessageId: 'u2' });
  assert.equal(tst.completions, 0, 'the next prompt must not be used as a proxy for the previous terminal boundary');
  assert.equal(tst.calls.length, 2);
});

test('reliable Context Memory always bounds foreground history to the last two user turns', async () => {
  const messages = [];
  for (let i = 0; i < 6; i++) { messages.push({ id: `u${i}`, role: 'user', content: `turn ${i} ${'x'.repeat(500)}` }); messages.push({ id: `a${i}`, role: 'assistant', content: 'y'.repeat(500) }); }

  const incomplete = new ContextCompiler({ tst: fakeTst({ observation_complete: false, stm: [{ key: 'x', value: 'y' }] }), cognitiveState: state() });
  const kept = await incomplete.compile({ sessionId: 's2', messages, userMessageId: 'u5', usableTokens: 1000, estimatedTokens: 5000 });
  assert.equal(kept.trimmed, false, 'incomplete retained state must fail closed even under context pressure');

  const complete = new ContextCompiler({ tst: fakeTst({ observation_complete: true, stm: [{ key: 'x', value: 'y' }] }), cognitiveState: state() });
  const trimmed = await complete.compile({ sessionId: 's3', messages, userMessageId: 'u5', usableTokens: 100000, estimatedTokens: 1000 });
  assert.equal(trimmed.trimmed, true, 'reliable retained state must bound history even far below half the model window');
  assert.deepEqual(trimmed.messages.filter((message) => message.role === 'user').map((message) => message.id), ['u4', 'u5']);
  assert.equal(trimmed.messages.some((message) => message.id === 'u3' || message.id === 'a3'), false);
});

test('plan mode uses 12 percent budget and orchestrator bypasses automatic TST context', async () => {
  const tst = fakeTst({ observation_complete: true, stm: [{ key: 'goal', value: 'x' }], plan_projection: { complete: true, coverage: { indexing_complete: true, indexed_files: 10, included_files: 10 }, files: ['src/a.mjs'] } });
  const planCompiler = new ContextCompiler({ tst, cognitiveState: state({ mode: 'plan' }) });
  const plan = await planCompiler.compile({ sessionId: 'p1', messages: [{ id: 'u', role: 'user', content: 'Plan this change' }], userMessageId: 'u', usableTokens: 100000 });
  assert.equal(plan.budgetTokens, 12000);
  assert.equal(plan.projectionComplete, true);

  const orchestratedTst = fakeTst({ observation_complete: true, stm: [{ key: 'x', value: 'y' }] });
  const orchestrated = new ContextCompiler({ tst: orchestratedTst, cognitiveState: state({ orchestrator: true }) });
  const output = await orchestrated.compile({ sessionId: 'o1', messages: [{ id: 'u', role: 'user', content: 'Do the work' }], userMessageId: 'u' });
  assert.equal(output.mode, 'orchestrator');
  assert.equal(orchestratedTst.calls.length, 0);
});

test('retrieval hints prioritize prompt paths and uncommitted files over latest-commit paths', async (t) => {
  const { root, git } = await gitProject(t);
  await mkdir(join(root, 'src'));
  for (const name of ['committed.mjs', 'staged.mjs', 'unstaged.mjs', 'deleted.mjs', 'rename-old.mjs']) {
    await writeFile(join(root, 'src', name), 'export const value = 1;\n');
  }
  await git('add', '.');
  await git('commit', '--quiet', '-m', 'Initial files');
  await writeFile(join(root, 'src/staged.mjs'), 'export const value = 2;\n');
  await git('add', 'src/staged.mjs');
  await writeFile(join(root, 'src/unstaged.mjs'), 'export const value = 3;\n');
  await writeFile(join(root, 'src/new file.mjs'), 'export const value = 4;\n');
  await rm(join(root, 'src/deleted.mjs'));
  await git('mv', 'src/rename-old.mjs', 'src/rename new.mjs');

  const tst = fakeTst({});
  const compiler = new ContextCompiler({ tst, cognitiveState: state() });
  await compiler.compile({ sessionId: 'dirty', projectRoot: root, messages: [{ role: 'user', content: 'Update src/staged.mjs' }], userMessageId: 'u' });
  const hints = tst.calls[0][2];
  assert.equal(hints[0], 'src/staged.mjs');
  assert.equal(hints.filter((hint) => hint === 'src/staged.mjs').length, 1);
  for (const path of ['src/unstaged.mjs', 'src/new file.mjs', 'src/deleted.mjs', 'src/rename new.mjs']) assert.ok(hints.includes(path), path);
  assert.equal(hints.includes('src/committed.mjs'), false, 'dirty worktree must not use latest-commit files');
  assert.equal(hints.includes('src/rename-old.mjs'), false, 'rename source is not a separate status entry');
  assert.ok(hints.includes('Update'), 'existing keyword hints remain');
});

test('clean retrieval hints use only the latest commit, including the initial commit', async (t) => {
  const { root, git } = await gitProject(t);
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/initial.mjs'), 'export const initial = 1;\n');
  await git('add', '.');
  await git('commit', '--quiet', '-m', 'Initial file');
  const tst = fakeTst({});
  const compiler = new ContextCompiler({ tst, cognitiveState: state() });
  await compiler.compile({ sessionId: 'clean', projectRoot: root, messages: [{ role: 'user', content: 'ok' }], userMessageId: 'u1' });
  assert.deepEqual(tst.calls[0][2], ['src/initial.mjs']);

  await writeFile(join(root, 'src/latest file.mjs'), 'export const latest = 2;\n');
  await git('add', '.');
  await git('commit', '--quiet', '-m', 'Latest file');
  await compiler.compile({ sessionId: 'clean', projectRoot: root, messages: [{ role: 'user', content: 'ok' }], userMessageId: 'u2' });
  assert.deepEqual(tst.calls[1][2], ['src/latest file.mjs']);
});

test('retrieval paths stay relative to the session project and within the hint cap', async (t) => {
  const { root, git } = await gitProject(t);
  const projectRoot = join(root, 'nested');
  await mkdir(projectRoot);
  await writeFile(join(root, 'outside.mjs'), 'export const outside = 1;\n');
  await writeFile(join(projectRoot, 'committed.mjs'), 'export const committed = 1;\n');
  await git('add', '.');
  await git('commit', '--quiet', '-m', 'Initial files');
  const tst = fakeTst({});
  const compiler = new ContextCompiler({ tst, cognitiveState: state() });
  await compiler.compile({ sessionId: 'nested', projectRoot, messages: [{ role: 'user', content: 'ok' }], userMessageId: 'u1' });
  assert.deepEqual(tst.calls[0][2], ['committed.mjs']);

  for (let i = 0; i < 40; i++) await writeFile(join(projectRoot, `new-${i}.mjs`), 'export const value = 1;\n');
  await compiler.compile({ sessionId: 'nested', projectRoot, messages: [{ role: 'user', content: 'Update src/explicit.mjs' }], userMessageId: 'u2' });
  const hints = tst.calls[1][2];
  assert.equal(hints.length, 32);
  assert.equal(hints[0], 'src/explicit.mjs');
  assert.ok(hints.slice(1).every((hint) => /^new-\d+\.mjs$/.test(hint)));
});

test('Git failures preserve prompt hints in non-Git and unborn projects', async (t) => {
  const { root, git } = await gitProject(t);
  await mkdir(join(root, 'plain'));
  for (const projectRoot of [root, join(root, 'plain'), join(root, 'missing')]) {
    if (projectRoot.endsWith('plain')) await rm(join(root, '.git'), { recursive: true, force: true });
    const tst = fakeTst({});
    const compiler = new ContextCompiler({ tst, cognitiveState: state() });
    await compiler.compile({ sessionId: 'no-git', projectRoot, messages: [{ role: 'user', content: 'Update src/explicit.mjs' }], userMessageId: 'u' });
    assert.equal(tst.calls[0][2][0], 'src/explicit.mjs');
    assert.ok(tst.calls[0][2].includes('Update'));
  }
});

test('STM compaction aborts without TST and never authorizes transcript mutation', async () => {
  const compiler = new ContextCompiler({ tst: { configured: false, status: { configured: false } }, cognitiveState: state() });
  const result = await compiler.stmCompactionDirective({ sessionId: 's', prompt: 'compact', messages: [] });
  assert.equal(result.abort, true);
  assert.match(result.directive, /preserve the full durable transcript/i);
});

test('automatic graph context retains retrieved hits for ordinary requests and brief follow-ups', async () => {
  for (const prompt of ['Make context compilation faster', 'ok']) {
    const tst = fakeTst({
      graph: [{ node: { path: 'src/runtime/context-compiler.mjs', name: 'ContextCompiler', signature: 'class ContextCompiler' } }],
      edges: [{ from: { path: 'src/runtime/context-compiler.mjs' }, to: { path: 'src/runtime/tst-client.mjs' }, kind: 'calls' }],
    });
    const compiler = new ContextCompiler({ tst, cognitiveState: state() });
    const output = await compiler.compile({ sessionId: 'automatic', messages: [{ role: 'user', content: prompt }], userMessageId: prompt });
    assert.equal(tst.calls[0][1], prompt, 'retrieval receives the complete user request');
    if (prompt.includes('context')) assert.ok(tst.calls[0][2].includes('context'), 'ordinary keywords remain retrieval hints');
    else assert.deepEqual(tst.calls[0][2], [], 'brief follow-up has no keyword or explicit code hints');
    assert.equal(output.injected, true);
    const block = output.messages.find((message) => message.role === 'system').content;
    assert.match(block, /WORKSPACE GRAPH/);
    assert.match(block, /context-compiler\.mjs :: ContextCompiler — class ContextCompiler/);
    assert.match(block, /context-compiler\.mjs -\[calls\]-> src\/runtime\/tst-client\.mjs/);
  }
});
