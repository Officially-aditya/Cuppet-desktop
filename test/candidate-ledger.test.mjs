import test from 'node:test';
import assert from 'node:assert/strict';
import { CandidateLedger, hasDurableUserCue, isSensitiveCandidate } from '../src/runtime/candidate-ledger.mjs';

test('model canonicalization alone does not become trusted admission evidence', async () => {
  const ledger = new CandidateLedger(); await ledger.ready();
  ledger.observe({ key: 'formatter', claim: 'Use biome', kind: 'preference', relation: 'support', sessionID: 's1', projectID: 'p1', sourceRef: 'model:1', timestampMs: 1, trustedSupport: false, explicitUser: false, downstreamVerified: false });
  const admission = ledger.admission('formatter', 'preference');
  assert.equal(admission.explicitUserPreference, false);
  assert.equal(admission.independentlyReinforced, false);
  assert.equal(ledger.entry('formatter', 'preference').support_count, 0);
});

test('explicit user preference is deterministic evidence while contradiction blocks it', async () => {
  const ledger = new CandidateLedger(); await ledger.ready();
  ledger.observe({ key: 'formatter', claim: 'Use biome', kind: 'preference', relation: 'support', sessionID: 's1', projectID: 'p1', sourceRef: 'user:1', timestampMs: 1, trustedSupport: true, explicitUser: true, downstreamVerified: false });
  assert.equal(ledger.admission('formatter', 'preference').explicitUserPreference, true);
  ledger.observe({ key: 'formatter', claim: 'Do not use biome', kind: 'preference', relation: 'contradiction', sessionID: 's1', projectID: 'p1', sourceRef: 'user:2', timestampMs: 2, trustedSupport: true, explicitUser: true, downstreamVerified: false });
  assert.equal(ledger.admission('formatter', 'preference').blocked, true);
});

test('durable cues and secret rejection remain deterministic', () => {
  assert.equal(hasDurableUserCue('I prefer pnpm for this project'), true);
  assert.equal(isSensitiveCandidate('api_key', 'sk-secret-that-should-never-be-memory'), true);
  assert.equal(isSensitiveCandidate('style', 'Use pnpm'), false);
});
