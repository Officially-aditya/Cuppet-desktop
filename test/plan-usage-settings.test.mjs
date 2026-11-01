import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function renderSettings(provider, initialSection = 'usage') {
  const source = readFileSync(new URL('../src/renderer/react/SettingsModal.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  const jsx = (type, props) => ({ type, props });
  vm.runInNewContext(compiled, {
    exports,
    require(name) {
      if (name === 'react') return {
        useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
        useRef: (current) => ({ current }),
        useCallback: (fn) => fn,
        useMemo: (fn) => fn(),
        useEffect: () => {},
      };
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === './use-modal-behavior') return { useModalBehavior: () => {} };
      if (name === './PlanUsagePanel') return { PlanUsagePanel: 'plan-usage-panel' };
      return {};
    },
    localStorage: { getItem: () => null },
  });
  const tree = exports.SettingsModal({
    provider, initialSection, onClose() {}, onSaved() {}, onOpenRemote() {}, onError() {},
  });
  function nodes(node) {
    if (node == null) return [];
    if (Array.isArray(node)) return node.flatMap(nodes);
    return [node, ...nodes(node.props?.children)];
  }
  return nodes(tree);
}

test('plan usage is mounted only on the Settings Usage page', () => {
  for (const providerID of ['codex', 'claude-code', 'antigravity', 'github-copilot']) {
    for (const section of ['general', 'security', 'account', 'platform', 'personalisation', 'devices', 'privacy', 'about']) {
      const nodes = renderSettings({ providerID }, section);
      assert.ok(!nodes.some((node) => node.type === 'plan-usage-panel'), providerID + ' ' + section);
    }
  }
});

test('Settings Usage displays plan limits before token totals for the active platform', () => {
  for (const provider of [
    { providerID: 'codex', primary: { providerID: 'codex' }, presets: [{ id: 'codex', label: 'Codex' }] },
    { providerID: 'claude-code', presets: [{ id: 'claude-code', label: 'Claude Code' }] },
    { providerID: 'antigravity', presets: [{ id: 'antigravity', label: 'Google Antigravity' }] },
    { providerID: 'github-copilot', presets: [{ id: 'github-copilot', label: 'GitHub Copilot' }] },
    { providerID: 'openai', primary: { providerID: 'codex' }, presets: [{ id: 'codex', label: 'Codex' }] },
  ]) {
    const nodes = renderSettings(provider);
    const planIndex = nodes.findIndex((node) => node.type === 'plan-usage-panel');
    assert.ok(planIndex >= 0, 'plan usage must be visible in Settings → Usage');
    const plan = nodes[planIndex];
    assert.equal(plan.props.providerID, provider.primary?.providerID || provider.providerID);
    assert.equal(plan.props.providerLabel, provider.presets[0].label);
    const tokenIndex = nodes.findIndex((node) => node.type?.name === 'UsagePanel');
    assert.ok(tokenIndex > planIndex, 'local token totals remain below plan usage');
    assert.ok(nodes.some((node) => node.type === 'button' && node.props.children === 'Usage'));
  }
});
