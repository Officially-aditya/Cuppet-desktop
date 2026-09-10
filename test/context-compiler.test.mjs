import test from 'node:test';
import assert from 'node:assert/strict';
import { ContextCompiler } from '../src/runtime/context-compiler.mjs';

function state({ mode = 'build', orchestrator = false } = {}) {
  return { mode: () => mode, snapshot: () => ({ orchestratorEnabled: orchestrator }) };
}

function fakeTst(prepared) {
  const calls = [];
  return {
    configured: true,
    status: { configured: true, connected: true, protocol: 'cuppet.tst.v3' },
    calls,
    async prepareContext(...args) { calls.push(args); return structuredClone(prepared); },
    async turnCompleted() {},
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
  assert.match(first.messages.find((m) => m.role === 'system').content, /trust="untrusted"/);
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

test('STM compaction aborts without TST and never authorizes transcript mutation', async () => {
  const compiler = new ContextCompiler({ tst: { configured: false, status: { configured: false } }, cognitiveState: state() });
  const result = await compiler.stmCompactionDirective({ sessionId: 's', prompt: 'compact', messages: [] });
  assert.equal(result.abort, true);
  assert.match(result.directive, /preserve the full durable transcript/i);
});
