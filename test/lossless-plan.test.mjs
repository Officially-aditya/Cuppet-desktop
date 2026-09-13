import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LosslessPlanStore, renderLosslessPlanContext } from '../src/runtime/lossless-plan.mjs';

function planPrompt(prefix = '') {
  const label = prefix ? `${prefix} ` : '';
  return [
    `# ${label}Phase 1 — Runtime`,
    `${label}Preserve the exact first requirement and do not rewrite it.`,
    '',
    `# ${label}Phase 2 — Context`,
    `${label}Compile context on a detached request only.`,
    '',
    `# ${label}Phase 3 — Tests`,
    `${label}Add parity and restart coverage.`,
  ].join('\n');
}

test('lossless plan preserves exact source and stable phases across restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-plan-'));
  try {
    const source = planPrompt();
    const store = new LosslessPlanStore(dir);
    const plan = await store.capture({ sessionID: 's1', messageID: 'm1', prompt: source, agent: 'plan' });
    assert.equal(plan.sources[0].prompt, source);
    assert.deepEqual(plan.phases.map((p) => p.id), ['P01', 'P02', 'P03']);
    const exact = await store.toolResult('s1', { action: 'phase', phaseID: 'P02' });
    assert.match(exact.output, /Compile context on a detached request only/);
    const restored = await new LosslessPlanStore(dir).get('s1');
    assert.equal(restored.sources[0].prompt, source);
    assert.match(renderLosslessPlanContext(restored, 'plan'), /CANONICAL IMPLEMENTATION PLAN/);
    assert.doesNotMatch(renderLosslessPlanContext(restored, 'plan'), /\[(?:pending|complete|done)\]/i, 'canonical requirements must not pretend to own execution progress');
    const files = await readdir(dir);
    assert.equal(files.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('concurrent captures serialize the full read-modify-write and cannot lose requirements', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-plan-race-'));
  try {
    const first = planPrompt('First');
    const second = planPrompt('Second');
    const store = new LosslessPlanStore(dir);
    await Promise.all([
      store.capture({ sessionID: 's-race', messageID: 'm-first', prompt: first, agent: 'plan' }),
      store.capture({ sessionID: 's-race', messageID: 'm-second', prompt: second, agent: 'plan' }),
    ]);

    const plan = await store.get('s-race');
    assert.equal(plan.sources.length, 2);
    assert.deepEqual(new Set(plan.sources.map((source) => source.messageID)), new Set(['m-first', 'm-second']));
    assert.deepEqual(new Set(plan.sources.map((source) => source.prompt)), new Set([first, second]));
    assert.equal(plan.phases.length, 6);
    assert.deepEqual(plan.phases.map((phase) => phase.id), ['P01', 'P02', 'P03', 'P04', 'P05', 'P06']);

    const restored = await new LosslessPlanStore(dir).get('s-race');
    assert.equal(restored.sources.length, 2);
    assert.equal(restored.phases.length, 6);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('fork produces an independent durable plan and remaps message provenance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-plan-fork-'));
  try {
    const store = new LosslessPlanStore(dir);
    await store.capture({ sessionID: 'source', messageID: 'm-source', prompt: planPrompt('Source'), agent: 'plan' });
    const forked = await store.fork('source', 'target', { 'm-source': 'm-target' });
    assert.equal(forked.sessionID, 'target');
    assert.equal(forked.sources[0].messageID, 'm-target');
    assert.equal(forked.phases[0].sourceMessageID, 'm-target');

    await store.capture({ sessionID: 'target', messageID: 'm-target-2', prompt: planPrompt('Target'), agent: 'plan' });
    const source = await store.get('source');
    const target = await store.get('target');
    assert.equal(source.sources.length, 1, 'target mutation must not alias source plan state');
    assert.equal(target.sources.length, 2);

    const restarted = new LosslessPlanStore(dir);
    assert.equal((await restarted.get('source')).sources.length, 1);
    assert.equal((await restarted.get('target')).sources.length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('delete waits behind in-flight mutation and removes both cache and durable state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-plan-delete-'));
  try {
    const store = new LosslessPlanStore(dir);
    const capture = store.capture({ sessionID: 's-delete', messageID: 'm1', prompt: planPrompt('Delete'), agent: 'plan' });
    const deletion = store.delete('s-delete');
    await Promise.all([capture, deletion]);
    assert.equal(await store.get('s-delete'), undefined);
    assert.equal(await new LosslessPlanStore(dir).get('s-delete'), undefined);
    assert.equal((await readdir(dir)).length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('ordinary short prompts are not captured as canonical plans', async () => {
  const store = new LosslessPlanStore();
  assert.equal(await store.capture({ sessionID: 's', messageID: 'm', prompt: 'Fix the typo', agent: 'build' }), undefined);
});
