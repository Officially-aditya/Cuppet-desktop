import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskAgentRouter } from '../src/runtime/pe3/task-agents.mjs';

test('PE3 keeps related turns together, splits explicit disjoint work, and reactivates dormant task', () => {
  let now = 1000;
  const router = new TaskAgentRouter({ now: () => ++now });
  router.register('session-a');
  router.recordTurn('Implement login validation in src/auth/login.ts', { touchedPaths: ['src/auth/login.ts'], recentSymbols: ['validateLogin'] });

  const same = router.route('Also update validateLogin tests in src/auth/login.ts');
  assert.equal(same.action, 'continue');
  assert.equal(same.agent.sessionID, 'session-a');

  const split = router.route('New task: implement invoice totals in src/billing/invoice.ts');
  assert.equal(split.action, 'create');
  router.register('session-b');
  router.recordTurn('Implement invoice totals in src/billing/invoice.ts', { touchedPaths: ['src/billing/invoice.ts'], recentSymbols: ['calculateInvoice'] });

  const back = router.route('Go back to src/auth/login.ts and finish validateLogin');
  assert.equal(back.action, 'reactivate');
  assert.equal(back.agent.sessionID, 'session-a');
});

test('PE3 preserves short, elliptical, and corrective conversational follow-ups on the active task', () => {
  const router = new TaskAgentRouter();
  router.register('session-a');
  const task = 'Review backlink targets and sitemap pages for this project';
  router.recordTurn(task);

  const followUps = [
    'yeah, what are these pages?',
    "please check the actual files before answering, this isn't helping at all",
    'why?',
    'what else?',
    'did you check the repository?',
    'can you verify?',
    'and the other pages?',
    'do that',
    'fix it',
    'now what?',
  ];

  for (const prompt of followUps) {
    const route = router.route(prompt);
    assert.equal(route.action, 'continue', prompt);
    assert.equal(route.agent.sessionID, 'session-a', prompt);
    assert.equal(route.semanticEligible, undefined, prompt);
  }

  router.recordTurn('yeah, what are these pages?');
  router.recordTurn("please check the actual files before answering, this isn't helping at all");
  assert.equal(router.active.taskDescriptor, task, 'conversational turns must not replace the semantic task anchor');
});

test('PE3 only escalates semantic novelty for sufficiently self-contained task requests', () => {
  const router = new TaskAgentRouter();
  router.register('session-a');
  router.recordTurn('Review backlink targets and sitemap pages for this project');

  const shortStandalone = router.route('Implement billing retries with webhook idempotency');
  assert.equal(shortStandalone.action, 'continue');
  assert.equal(shortStandalone.semanticEligible, undefined);
  assert.equal(shortStandalone.reason, 'short or elliptical prompt preserves the active agent');

  const detailedStandalone = router.route('Implement a resilient billing retry worker with Stripe webhook idempotency and dead-letter recovery');
  assert.equal(detailedStandalone.action, 'continue');
  assert.equal(detailedStandalone.semanticEligible, true);
  assert.match(detailedStandalone.reason, /ambiguous or weak mismatch/);

  const explicit = router.route('New task: implement billing retries with webhook idempotency');
  assert.equal(explicit.action, 'create');
  assert.equal(explicit.reason, 'explicit task switch creates a sibling task agent');
});

test('PE3 still splits on hard contradictory workspace evidence without requiring a long prompt', () => {
  const router = new TaskAgentRouter();
  router.register('session-a');
  router.recordTurn('Implement login validation in src/auth/login.ts', { touchedPaths: ['src/auth/login.ts'] });

  const route = router.route('Fix src/billing/invoice.ts');
  assert.equal(route.action, 'create');
  assert.equal(route.reason, 'hard workspace mismatch with no matching dormant agent');
});

test('workspace mutation removes dormant file privilege and requires refresh on reactivation', () => {
  const router = new TaskAgentRouter();
  router.register('session-a');
  router.recordTurn('Work in src/auth/login.ts', { activePaths: ['src/auth/login.ts'], touchedPaths: ['src/auth/login.ts'] });
  router.register('session-b');
  router.recordTurn('Work in src/billing/invoice.ts', { touchedPaths: ['src/billing/invoice.ts'] });

  router.noteWorkspaceChange(['src/auth/login.ts']);
  const auth = router.list().find((agent) => agent.sessionID === 'session-a');
  assert.deepEqual(auth.stalePaths, ['src/auth/login.ts']);
  assert.equal(auth.activePaths.includes('src/auth/login.ts'), false);
  assert.equal(auth.touchedPaths.includes('src/auth/login.ts'), false);

  router.activate('session-a');
  router.acknowledgeRefresh('session-a', ['src/auth/login.ts']);
  assert.deepEqual(router.active.stalePaths, []);
});
