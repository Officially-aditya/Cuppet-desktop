import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyTool, groupTrace, liveStatus, liveThoughtLine, summarizeTrace, toolActivityLabel, workGroupTiming } from '../src/renderer/react/trace-summary.ts';

const tool = (id, name, args = {}, status = 'complete', sequence = 1) => ({ id, type: 'tool', tool: name, argumentsJson: JSON.stringify(args), status, sequence });
const thought = (text, sequence = 1) => ({ id: `thought-${sequence}`, type: 'reasoning', text, sequence });

test('tool classification covers native, provider, and namespaced calls', () => {
  for (const [kind, names] of Object.entries({
    read: ['Read', 'read_file', 'workspace_read', 'tst_read', 'functions.readFile'],
    search: ['Glob', 'grep', 'tst_explore', 'cuppet_memory_search'],
    edit: ['Edit', 'apply_patch', 'tst_edit_batch', 'file_diff'],
    write: ['Write', 'create_file', 'workspace_write'],
    command: ['Bash', 'exec_command', 'functions.shell'],
    validate: ['tst_validate', 'run_tests', 'lint', 'verify'],
    other: ['question', 'cuppet_plan', 'unknown'],
  })) for (const name of names) assert.equal(classifyTool(name), kind, name);
});

test('subagent activity identifies the worker and model', () => {
  const args = JSON.stringify({ name: 'Review', model: 'secondary' });
  assert.equal(toolActivityLabel('cuppet_subagent', args, 'running'), 'Review · secondary is working…');
  assert.equal(toolActivityLabel('cuppet_subagent', args, 'complete'), 'Review · secondary completed');
  assert.equal(toolActivityLabel('cuppet_delegate', '{}', 'running'), 'Running subagents…');
});

test('thought previews extract completed bold headings or short first sentences', () => {
  assert.equal(liveThoughtLine('**Planning the fix**\n\nInspecting files.'), 'Planning the fix');
  assert.equal(liveThoughtLine('**Reviewing `src/app.ts` and [tests](https://example.com)**'), 'Reviewing src/app.ts and tests');
  assert.equal(liveThoughtLine('**Checking `src/my_file.ts`**'), 'Checking src/my_file.ts');
  assert.equal(liveThoughtLine('Inspecting the code. Then updating the tests.'), 'Inspecting the code.');
  assert.equal(liveThoughtLine('### Checking the result\nExtra context'), 'Checking the result');
  assert.equal(liveThoughtLine(''), '');
});

test('partial streamed headings and long raw thoughts do not flash in the header', () => {
  for (const prefix of ['**', '**Planning', '**Planning the fix*']) assert.equal(liveThoughtLine(prefix), '');
  assert.equal(liveThoughtLine('A very long thought '.repeat(1000)), '');
  assert.equal(liveThoughtLine('A short sentence. ' + 'A very long thought '.repeat(1000)), 'A short sentence.');
});

test('live status uses the latest thought, then running tool, then a safe fallback', () => {
  const running = tool('cmd', 'exec_command', { command: 'npm test' }, 'running', 3);
  assert.equal(liveStatus([thought('**Old heading**'), running, thought('**Checking results**', 4)]), 'Checking results');
  assert.equal(liveStatus([running]), 'Running npm test…');
  assert.equal(liveStatus([thought('**Not finished'), running]), 'Running npm test…');
  assert.equal(liveStatus([thought('Raw reasoning '.repeat(1000))]), 'Thinking…');
  assert.equal(liveStatus([]), 'Working…');
  assert.equal(liveStatus([tool('done', 'bash')]), 'Ran command');
  assert.equal(liveStatus([tool('read', 'read_file', { path: 'app.ts' }, 'running')]), 'Reading app.ts…');
  assert.equal(liveStatus([tool('read', 'read_file', { path: 'app.ts' })]), 'Read app.ts');
});

test('summary counts unique successful files, including batch targets', () => {
  const trace = [tool('a', 'tst_read', { reads: [{ path: 'a.ts' }, { path: 'b.ts' }] }),
    tool('b', 'Read', { file_path: 'a.ts' }), tool('c', 'tst_read', { paths: ['b.ts', 'c.ts'] }),
    tool('d', 'tst_edit_batch', { operations: [{ target: { path: 'a.ts' } }, { path: 'b.ts' }] })];
  const summary = summarizeTrace(trace);
  assert.equal(summary.label, 'Edited 2 files · read 3 files');
  assert.equal(summary.counts.read, 3);
  assert.equal(summary.counts.edit, 2);
  assert.equal(summary.total, 4);
});

test('summary ranks commands and edits and limits detailed clauses', () => {
  const summary = summarizeTrace([tool('read', 'read_file'), tool('cmd', 'bash'), tool('edit', 'workspace_edit'),
    tool('write', 'workspace_write'), tool('search', 'glob'), tool('other', 'cuppet_plan')]);
  assert.equal(summary.label, 'Ran 1 command · edited 1 file · performed 4 other actions');
  assert.equal(summarizeTrace([tool('search', 'grep'), tool('search2', 'glob')]).label, 'Performed 2 searches');
});

test('running and failed calls remain visible without being counted as successes', () => {
  const summary = summarizeTrace([tool('read', 'read_file', { path: 'a.ts' }),
    tool('running', 'read_file', { path: 'b.ts' }, 'running'), tool('failed', 'workspace_edit', { path: 'a.ts' }, 'error')]);
  assert.equal(summary.label, 'Read 1 file');
  assert.equal(summary.running, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.counts.edit, 0);
  assert.equal(summarizeTrace([]).label, '');
});

test('malformed tool arguments and unknown tools still have useful summaries', () => {
  assert.equal(summarizeTrace([{ ...tool('read', 'read_file'), argumentsJson: '{unfinished' }]).label, 'Read 1 file');
  assert.equal(summarizeTrace([tool('other', 'custom_tool')]).label, 'Performed 1 other action');
  assert.equal(toolActivityLabel('cuppet_memory_search', '{}', 'running'), 'Searching memory…');
  assert.equal(toolActivityLabel('glob', '{}', 'running'), 'Searching workspace…');
  assert.equal(toolActivityLabel('bash', '{}', 'error'), 'Command failed');
});

test('grouping preserves chronology, boundaries, item identity, and the first activity ID as a group grows', () => {
  const first = tool('first', 'read_file', {}, 'complete', 1);
  const second = tool('second', 'read_file', {}, 'running', 2);
  const commentary = { ...thought('Next step.', 3), kind: 'commentary' };
  const reasoning = thought('Hidden thought.', 4);
  const warning = { id: 'status', type: 'status', text: 'Retrying', sequence: 6 };
  const trace = [warning, tool('third', 'bash', {}, 'error', 5), reasoning, commentary, second, first, tool('last', 'glob', {}, 'complete', 7)];
  const groups = groupTrace(trace);
  assert.deepEqual(groups.map((entry) => entry.id), ['first', commentary.id, reasoning.id, 'third', 'status', 'last']);
  assert.equal(groups[0].items[0], first);
  assert.equal(groups[0].items[1], second);
  assert.equal(groups[0].id, groupTrace([first])[0].id);
  assert.deepEqual(groups[2].items.map(item => item.id), [reasoning.id]);
  assert.deepEqual(groups[3].items.map(item => item.id), ['third']);
  assert.equal(trace[0], warning, 'sorting must not mutate the store');
});

test('work timing uses the actual first activity and freezes at the next output or turn completion', () => {
  const group = { id: 'a', type: 'work-group', items: [{ ...tool('a', 'read_file'), startedAt: 2000, completedAt: 4000 }] };
  const next = { ...thought('Here is the next step.'), kind: 'commentary', startedAt: 6000, completedAt: 7000 };
  assert.deepEqual(workGroupTiming(group, next, 1000, 20000), { startedAt: 2000, completedAt: 6000 });
  assert.deepEqual(workGroupTiming(group, undefined, 1000, 20000), { startedAt: 2000, completedAt: 20000 });
  assert.deepEqual(workGroupTiming({ ...group, items: [tool('legacy', 'read_file')] }, undefined, 1000, 13000), { startedAt: 1000, completedAt: 13000 });
});

test('thinking keeps its measured duration when tools and the answer continue afterward', () => {
  const group = { id: 'thought', type: 'work-group', items: [{ ...thought('Provider reasoning.'), startedAt: 1000, completedAt: 4000 }] };
  assert.deepEqual(workGroupTiming(group, undefined, 500, 20000), { startedAt: 1000, completedAt: 4000 });
  const next = { ...thought('Progress text.'), kind: 'commentary', startedAt: 6000 };
  assert.deepEqual(workGroupTiming(group, next, 500, 20000), { startedAt: 1000, completedAt: 4000 });
});
