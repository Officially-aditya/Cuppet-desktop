import test from 'node:test';
import assert from 'node:assert/strict';
import { ContextCompiler } from '../src/runtime/context-compiler.mjs';

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

test('STM compaction aborts without TST and never authorizes transcript mutation', async () => {
  const compiler = new ContextCompiler({ tst: { configured: false, status: { configured: false } }, cognitiveState: state() });
  const result = await compiler.stmCompactionDirective({ sessionId: 's', prompt: 'compact', messages: [] });
  assert.equal(result.abort, true);
  assert.match(result.directive, /preserve the full durable transcript/i);
});

test('ordinary prompt words do not inject speculative graph matches', async () => {
  const tst = fakeTst({
    stm: [{ key: 'goal', value: 'event synthesis' }],
    graph: [
      { node: { path: 'src/unrelated.ts', name: 'block', kind: 'variable_declarator' } },
      { node: { path: 'src/other.ts', name: 'nodes', kind: 'variable_declarator' } },
    ],
    edges: [{ from: { path: 'src/unrelated.ts' }, to: { path: 'src/other.ts' }, kind: 'calls' }],
  });
  const compiler = new ContextCompiler({ tst, cognitiveState: state() });
  const prompt = 'The graph block contains nodes but none helped with event synthesis';
  const output = await compiler.compile({ sessionId: 'natural', messages: [{ role: 'user', content: prompt }], userMessageId: 'u1' });
  assert.equal(tst.calls[0][1], prompt, 'memory retrieval still receives the complete prompt');
  assert.deepEqual(tst.calls[0][2], [], 'ordinary words are not code anchors');
  assert.doesNotMatch(output.messages.find((message) => message.role === 'system').content, /WORKSPACE GRAPH|unrelated\.ts|other\.ts/);
});

test('explicit symbols survive long prose and irrelevant leading graph results', async () => {
  const target = { path: 'src/browser-control/tools.ts', name: 'handleBrowserToolCall', kind: 'function_declaration', signature: 'function handleBrowserToolCall(input)', content_hash: 'hash', target_id: 'target' };
  const tst = fakeTst({
    graph: [...Array.from({ length: 10 }, (_, i) => ({ node: { path: `src/other-${i}.ts`, name: 'block', kind: 'variable_declarator' } })), { node: target }, { node: target }],
    edges: [
      { from: { path: 'src/unrelated.ts' }, to: { path: 'src/other.ts' }, kind: 'calls' },
      { from: target, to: { path: 'src/browser-control/transport.ts', name: 'send' }, kind: 'calls' },
    ],
  });
  const compiler = new ContextCompiler({ tst, cognitiveState: state() });
  const prompt = 'Investigate why the browser action fails after the session has been running for a while and trace handleBrowserToolCall';
  const output = await compiler.compile({ sessionId: 'symbol', messages: [{ role: 'user', content: prompt }], userMessageId: 'u1' });
  const block = output.messages.find((message) => message.role === 'system').content;
  assert.deepEqual(tst.calls[0][2], ['handleBrowserToolCall']);
  assert.equal((block.match(/ :: handleBrowserToolCall/g) ?? []).length, 1);
  assert.match(block, /tools\.ts -\[calls\]-> src\/browser-control\/transport\.ts/);
  assert.doesNotMatch(block, /other-\d|unrelated\.ts|content_hash|target_id/);
});

test('explicit paths deduplicate file nodes and omit incidental local bindings', async () => {
  const path = 'src/browser-control/tools.ts';
  const tst = fakeTst({
    graph: [
      { node: { path, name: path, kind: 'file' } },
      { node: { path, name: 'src::browser-control::tools', kind: 'module' } },
      { node: { path: 'src::browser-control::tools', name: 'tools', kind: 'module' } },
      ...Array.from({ length: 8 }, (_, i) => ({ node: { path, name: `local${i}`, kind: 'variable_declarator' } })),
      { node: { path, name: 'handleBrowserToolCall', kind: 'function_declaration' } },
      { node: { path, name: 'TOOL_LIMIT', kind: 'exported_variable_declarator' } },
      { node: { path: 'src/unrelated.ts', name: 'other', kind: 'function_declaration' } },
    ],
  });
  const compiler = new ContextCompiler({ tst, cognitiveState: state() });
  const output = await compiler.compile({ sessionId: 'path', messages: [{ role: 'user', content: `Inspect ${path}` }], userMessageId: 'u1' });
  const block = output.messages.find((message) => message.role === 'system').content;
  assert.match(block, / :: handleBrowserToolCall/);
  assert.match(block, / :: TOOL_LIMIT/);
  assert.equal(block.split('\n').filter((line) => line === `- ${path}`).length, 1);
  assert.doesNotMatch(block, /local\d|src::| :: src\/|unrelated\.ts/);
});

test('quoted identifiers and calls keep specifically requested local symbols', async () => {
  for (const prompt of ['Inspect `nodes` in src/a.ts', 'Trace render() in src/a.ts']) {
    const tst = fakeTst({
      graph: [
        { node: { path: 'src/a.ts', name: 'nodes', kind: 'variable_declarator' } },
        { node: { path: 'src/a.ts', name: 'block', kind: 'variable_declarator' } },
        { node: { path: 'src/a.ts', name: 'render', kind: 'function_declaration' } },
      ],
    });
    const compiler = new ContextCompiler({ tst, cognitiveState: state() });
    const output = await compiler.compile({ sessionId: 'quoted', messages: [{ role: 'user', content: prompt }], userMessageId: prompt });
    const block = output.messages.find((message) => message.role === 'system').content;
    assert.match(block, prompt.includes('`nodes`') ? / :: nodes/ : / :: render/);
    assert.doesNotMatch(block, / :: block/);
  }
});

test('top-level filenames anchor automatic graph context', async () => {
  const tst = fakeTst({ graph: [{ node: { path: 'package.json', name: 'package.json', kind: 'file' } }] });
  const compiler = new ContextCompiler({ tst, cognitiveState: state() });
  const output = await compiler.compile({ sessionId: 'filename', messages: [{ role: 'user', content: 'Inspect package.json' }], userMessageId: 'u1' });
  assert.deepEqual(tst.calls[0][2], ['package.json']);
  assert.match(output.messages.find((message) => message.role === 'system').content, /- package\.json\n/);
});
