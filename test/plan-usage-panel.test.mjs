import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { normalizeCodexPlanUsage } from '../src/runtime/provider-plan-usage.mjs';
import { normalizeClaudePlanUsage, normalizeAntigravityPlanUsage, normalizeCopilotPlanUsage } from '../src/runtime/plan-usage-normalizers.mjs';

const compiled = ts.transpileModule(
  readFileSync(new URL('../src/renderer/react/PlanUsagePanel.tsx', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } },
).outputText;
const available = (usedPercent = 25, resetsAt = 2000000000) => normalizeCodexPlanUsage({
  rateLimits: { secondary: { usedPercent, windowDurationMins: 10080, resetsAt } },
}, { planType: 'plus' });
const empty = (providerID, status = 'unsupported', message = 'Plan usage is not available for this platform yet.') =>
  ({ providerID, status, message, planType: null, limits: [], fetchedAt: null });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function fixture(load, initialProvider = 'codex') {
  const state = [], refs = [], effects = [], timers = new Map(), listeners = new Map();
  let stateIndex, refIndex, effectIndex, queued, tree, writes = 0, timerID = 0;
  let props = { providerID: initialProvider, providerLabel: initialProvider };
  const exports = {};
  const jsx = (type, props) => ({ type, props });
  vm.runInNewContext(compiled, {
    exports, Date, Error,
    require(name) {
      if (name === 'react') return {
        useState(initial) {
          const index = stateIndex++;
          if (!(index in state)) state[index] = initial;
          return [state[index], (next) => { state[index] = typeof next === 'function' ? next(state[index]) : next; writes++; }];
        },
        useRef(initial) { const index = refIndex++; return refs[index] ??= { current: initial }; },
        useEffect(effect, deps) {
          const index = effectIndex++;
          const previous = effects[index];
          if (!previous || deps.some((dep, key) => !Object.is(dep, previous.deps[key]))) {
            queued.push(() => { previous?.cleanup?.(); effects[index] = { deps, cleanup: effect() }; });
          }
        },
      };
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      throw new Error('Unexpected import: ' + name);
    },
    window: {
      cuppet: { usage: { plan: load } },
      setInterval(fn, ms) { assert.equal(ms, 60000); timers.set(++timerID, fn); return timerID; },
      clearInterval(id) { timers.delete(id); },
      addEventListener(name, fn) { listeners.set(name, fn); },
      removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
    },
  });
  function render(next = {}) {
    props = { ...props, ...next };
    stateIndex = refIndex = effectIndex = 0;
    queued = [];
    tree = exports.PlanUsagePanel(props);
    queued.forEach((effect) => effect());
    return tree;
  }
  function walk(node) {
    if (node == null) return [];
    if (Array.isArray(node)) return node.flatMap(walk);
    return [node, ...walk(node.props?.children)];
  }
  const nodes = () => walk(tree);
  render();
  return {
    render, nodes, timers, listeners,
    text: () => nodes().filter((node) => typeof node === 'string' || typeof node === 'number').join(''),
    progress: () => nodes().filter((node) => node.type === 'progress'),
    button: () => nodes().find((node) => node.type === 'button'),
    async settle() { await new Promise(setImmediate); render(); },
    refresh() { this.button().props.onClick(); render(); },
    tick() { [...timers.values()].forEach((fn) => fn()); render(); },
    focus() { listeners.get('focus')?.(); render(); },
    writes: () => writes,
    unmount() { effects.forEach((effect) => effect.cleanup?.()); },
  };
}

test('weekly usage displays remaining and used allowance, actual reset time, and plan name', async () => {
  for (const used of [0, 25, 100]) {
    const ui = fixture(async () => available(used));
    assert.equal(ui.button().props.disabled, true);
    assert.match(ui.text(), /Checking plan usage/);
    await ui.settle();
    assert.match(ui.text(), /Weekly limit/);
    assert.match(ui.text(), new RegExp((100 - used) + '% remaining'));
    assert.match(ui.text(), new RegExp(used + '% used'));
    assert.match(ui.text(), /Resets /);
    assert.match(ui.text(), /plus/);
    assert.equal(ui.progress()[0].props.value, used);
    assert.equal(ui.progress()[0].props.max, 100);
    assert.equal(ui.button().props.disabled, false);
    ui.unmount();
  }
});

test('refresh, focus and the one-minute timer fetch again without overlapping requests', async () => {
  const requests = [];
  const ui = fixture(() => { const request = deferred(); requests.push(request); return request.promise; });
  ui.focus(); ui.tick();
  assert.equal(requests.length, 1);
  requests[0].resolve(available(10)); await ui.settle();
  ui.refresh(); ui.focus(); ui.tick();
  assert.equal(requests.length, 2);
  requests[1].resolve(available(20)); await ui.settle();
  ui.tick();
  assert.equal(requests.length, 3);
  requests[2].resolve(available(30)); await ui.settle();
  ui.focus();
  assert.equal(requests.length, 4);
  requests[3].resolve(available(40)); await ui.settle();
  assert.match(ui.text(), /60% remaining/);
  ui.unmount();
});

test('switching platforms hides prior allowances immediately and ignores late responses even after switching back', async () => {
  const requests = [];
  const ui = fixture((providerID) => { const request = deferred(); requests.push({ providerID, ...request }); return request.promise; });
  ui.render({ providerID: 'claude-code', providerLabel: 'Claude Code' });
  assert.equal(ui.progress().length, 0);
  requests[1].resolve(empty('claude-code')); await ui.settle();
  assert.match(ui.text(), /not available for this platform/);
  ui.render({ providerID: 'codex', providerLabel: 'Codex' });
  requests[2].resolve(available(20)); await ui.settle();
  requests[0].resolve(available(99)); await ui.settle();
  assert.match(ui.text(), /80% remaining/);
  assert.doesNotMatch(ui.text(), /1% remaining/);
  ui.render({ providerID: 'openai', providerLabel: 'OpenAI' });
  assert.equal(ui.progress().length, 0, 'old platform usage cannot flash during a switch');
  requests[3].resolve(empty('openai')); await ui.settle();
  ui.unmount();
});

test('a failed refresh removes previous allowance values and remains retryable', async () => {
  let count = 0;
  const ui = fixture(async () => { if (++count === 2) throw new Error('temporarily offline'); return available(25); });
  await ui.settle();
  ui.refresh(); await ui.settle();
  assert.equal(ui.progress().length, 0);
  assert.match(ui.text(), /temporarily offline/);
  assert.ok(ui.nodes().some((node) => node.props?.role === 'alert'));
  assert.equal(ui.button().props.disabled, false);
  ui.refresh(); await ui.settle();
  assert.match(ui.text(), /75% remaining/);
  ui.unmount();
});

test('unknown and passed reset times never fabricate a reset or renew an exhausted allowance', async () => {
  for (const reset of [null, 1]) {
    const ui = fixture(async () => available(100, reset));
    await ui.settle();
    assert.match(ui.text(), reset === null ? /Reset time not reported/ : /awaiting provider update/);
    assert.equal(ui.progress()[0].props.value, 100);
    assert.match(ui.text(), /0% remaining/);
    ui.unmount();
  }
});

test('signed-out, unsupported and empty responses show a reason without percentage bars', async () => {
  for (const status of ['signed-out', 'unsupported', 'unavailable']) {
    const ui = fixture(async () => empty('codex', status, 'Check your account.'));
    await ui.settle();
    assert.equal(ui.progress().length, 0);
    assert.match(ui.text(), /Check your account/);
    assert.doesNotMatch(ui.text(), /% remaining/);
    ui.unmount();
  }
  let calls = 0;
  const ui = fixture(async () => { calls++; }, '');
  await ui.settle();
  assert.equal(calls, 0);
  assert.match(ui.text(), /Choose a platform/);
  assert.equal(ui.button().props.disabled, true);
  ui.unmount();
});

test('mismatched provider responses fail visibly and unmount retires all polling and state updates', async () => {
  const ui = fixture(async () => empty('other'));
  await ui.settle();
  assert.match(ui.text(), /did not match/);
  assert.equal(ui.progress().length, 0);
  ui.unmount();
  const request = deferred();
  const pending = fixture(() => request.promise);
  pending.unmount();
  const writes = pending.writes();
  assert.equal(pending.timers.size, 0);
  assert.equal(pending.listeners.size, 0);
  request.resolve(available()); await new Promise(setImmediate);
  assert.equal(pending.writes(), writes);
});

test('Claude, Antigravity and Copilot render their own plan windows in Settings', async () => {
  const reports = [
    normalizeClaudePlanUsage({ five_hour: { utilization: 25 }, seven_day: { utilization: 60 }, seven_day_opus: { utilization: 100 } }, { planType: 'max' }),
    normalizeAntigravityPlanUsage({ groups: [{ displayName: 'Gemini Pro', buckets: [{ bucketId: 'weekly', window: 'weekly', remainingFraction: 0.4 }] }] }),
    normalizeCopilotPlanUsage({ quotaSnapshots: { ai_credits: { usedRequests: 25, entitlementRequests: 100, remainingPercentage: 75 } } }),
  ];
  for (const report of reports) {
    const ui = fixture(async () => report, report.providerID);
    await ui.settle();
    assert.equal(ui.progress().length, report.limits.flatMap(l => l.windows).length);
    assert.match(ui.text(), /% remaining/);
    assert.doesNotMatch(ui.text(), /unavailable/);
    if (report.providerID === 'claude-code') assert.match(ui.text(), /Weekly limit · opus/);
    if (report.providerID === 'antigravity') assert.match(ui.text(), /Gemini Pro/);
    if (report.providerID === 'github-copilot') assert.match(ui.text(), /25 of 100 used this period/);
    ui.unmount();
  }
});

test('unlimited and zero-sized Copilot allowances show quantities without misleading percentage bars', async () => {
  const report = normalizeCopilotPlanUsage({ quotaSnapshots: {
    chat: { entitlementRequests: -1, isUnlimitedEntitlement: true, usedRequests: 123 },
    premium_interactions: { entitlementRequests: 0, usedRequests: 0, remainingPercentage: 0 },
  } });
  const ui = fixture(async () => report, 'github-copilot');
  await ui.settle();
  assert.match(ui.text(), /Unlimited allowance · 123 used this period/);
  assert.match(ui.text(), /0 of 0 used this period/);
  assert.doesNotMatch(ui.text(), /% used|% remaining/);
  assert.equal(ui.progress().length, 0);
  ui.unmount();
});
