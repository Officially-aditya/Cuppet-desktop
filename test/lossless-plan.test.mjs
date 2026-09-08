import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LosslessPlanStore, renderLosslessPlanContext } from '../src/runtime/lossless-plan.mjs';

function planPrompt() {
  return [
    '# Phase 1 — Runtime',
    'Preserve the exact first requirement and do not rewrite it.',
    '',
    '# Phase 2 — Context',
    'Compile context on a detached request only.',
    '',
    '# Phase 3 — Tests',
    'Add parity and restart coverage.',
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
    const files = await import('node:fs/promises').then((fs) => fs.readdir(dir));
    assert.equal(files.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('ordinary short prompts are not captured as canonical plans', async () => {
  const store = new LosslessPlanStore();
  assert.equal(await store.capture({ sessionID: 's', messageID: 'm', prompt: 'Fix the typo', agent: 'build' }), undefined);
});
