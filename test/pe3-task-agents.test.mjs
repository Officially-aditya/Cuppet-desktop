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
