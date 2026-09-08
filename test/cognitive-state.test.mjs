import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CognitiveStateStore } from '../src/runtime/cognitive-state.mjs';

test('plan/orchestrator/background controls survive restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-cognitive-state-'));
  const path = join(dir, 'state.json');
  try {
    const first = new CognitiveStateStore(path); await first.ready();
    await first.setMode('s1', 'plan');
    await first.setOrchestrator(true);
    await first.setBackgroundPaused(true);

    const restored = new CognitiveStateStore(path); await restored.ready();
    assert.equal(restored.mode('s1'), 'plan');
    assert.equal(restored.snapshot().orchestratorEnabled, true);
    assert.equal(restored.snapshot().backgroundPaused, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
