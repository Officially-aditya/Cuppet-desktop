import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadModule } from './helpers/load-tsx.mjs';
import { PROVIDER_PRESETS } from '../src/main/provider-presets.mjs';

function nodes(node) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  return [node, ...nodes(node.props?.children)];
}

function fixture({ iconOnly, open = true, disabled = false } = {}) {
  const options = [
    { value: 'first', label: 'First platform', icon: createElement('svg', { 'data-logo': 'first', 'aria-hidden': true }) },
    { value: 'blocked', label: 'Blocked platform', disabled: true, icon: createElement('svg', { 'data-logo': 'blocked', 'aria-hidden': true }) },
    { value: 'last', label: 'Last platform', icon: createElement('svg', { 'data-logo': 'last', 'aria-hidden': true }) },
  ];
  const changes = [], slots = [];
  let index = 0;
  const { SelectControl } = loadModule(fileURLToPath(new URL('../src/renderer/react/SelectControl.tsx', import.meta.url)), {
    react: {
      useId: () => 'select-test',
      useRef: () => ({ current: null }),
      useEffect: () => {},
      useState(initial) {
        const i = index++;
        if (!(i in slots)) slots[i] = i === 0 ? open : typeof initial === 'function' ? initial() : initial;
        return [slots[i], (next) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }];
      },
    },
  });
  const render = () => {
    index = 0;
    return SelectControl({ value: 'first', options, ariaLabel: 'Select platform', iconOnly, disabled, onChange: (id) => changes.push(id) });
  };
  return { render, changes };
}

test('icon-only select shows logos in the trigger and menu with accessible names and hover labels', () => {
  const view = fixture({ iconOnly: true }).render();
  const trigger = nodes(view).find((node) => node.props.className === 'cuppet-select-trigger');
  assert.equal(trigger.props['aria-label'], 'Select platform: First platform');
  assert.equal(trigger.props.title, 'First platform');
  const options = nodes(view).filter((node) => node.props.role === 'option');
  assert.deepEqual(options.map((node) => node.props['aria-label']), ['First platform', 'Blocked platform', 'Last platform']);
  assert.deepEqual(options.map((node) => node.props.title), ['First platform', 'Blocked platform', 'Last platform']);
  assert.equal(options[0].props['aria-selected'], true);
  assert.equal(options[1].props.disabled, true);
  const html = renderToStaticMarkup(view);
  assert.equal((html.match(/data-logo=/g) ?? []).length, 4);
  assert.doesNotMatch(html.replace(/<[^>]*>/g, ''), /platform/);
});

test('ordinary selects keep visible text and their existing accessible label', () => {
  const view = fixture().render();
  const trigger = nodes(view).find((node) => node.props.className === 'cuppet-select-trigger');
  assert.equal(trigger.props['aria-label'], 'Select platform');
  const html = renderToStaticMarkup(view);
  assert.match(html.replace(/<[^>]*>/g, ''), /First platform/);
  assert.doesNotMatch(html, /data-logo=/);
});

test('icon-only keyboard navigation skips disabled choices and selects the next enabled platform', (t) => {
  const previous = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => 0;
  t.after(() => {
    if (previous === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previous;
  });
  const select = fixture({ iconOnly: true });
  const trigger = () => nodes(select.render()).find((node) => node.props.className === 'cuppet-select-trigger');
  trigger().props.onKeyDown({ key: 'ArrowDown', preventDefault() {} });
  trigger().props.onKeyDown({ key: 'Enter', preventDefault() {} });
  assert.deepEqual(select.changes, ['last']);
  assert.equal(trigger().props['aria-expanded'], false);
});

test('icon-only disabled controls keep a disabled trigger', () => {
  const view = fixture({ iconOnly: true, disabled: true, open: false }).render();
  assert.equal(nodes(view).find((node) => node.props.className === 'cuppet-select-trigger').props.disabled, true);
  assert.ok(!nodes(view).some((node) => node.props.role === 'listbox'));
});

test('every built-in platform has a bundled logo and custom or prototype names use the fallback', () => {
  const { PlatformLogo } = loadModule(fileURLToPath(new URL('../src/renderer/react/PlatformLogo.tsx', import.meta.url)));
  for (const providerID of Object.keys(PROVIDER_PRESETS)) {
    const logo = PlatformLogo({ providerID });
    assert.equal(logo.props['data-platform-logo'], providerID);
    assert.equal(logo.props['aria-hidden'], 'true');
    const mask = logo.props.style.maskImage;
    assert.ok(mask.startsWith('url("data:image/svg+xml,'));
    const svg = decodeURIComponent(mask.slice('url("data:image/svg+xml,'.length, -2));
    assert.match(svg, /viewBox="0 0 24 24"/);
    assert.match(svg, /<path\b/);
  }
  const fallback = PlatformLogo({ providerID: '' }).props.style.maskImage;
  for (const providerID of ['', 'custom-platform', '__proto__', 'constructor', 'toString']) {
    const logo = PlatformLogo({ providerID });
    assert.equal(logo.props['data-platform-logo'], 'generic');
    assert.equal(logo.props.style.maskImage, fallback);
  }
});
