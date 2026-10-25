import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './helpers/load-tsx.mjs';

function cacheFixture(t, fetch) {
  const previous = globalThis.window;
  globalThis.window = { cuppet: { sessions: { attachment: fetch } } };
  t.after(() => { globalThis.window = previous; });
  return loadModule(new URL('../src/renderer/react/attachment-cache.ts', import.meta.url).pathname);
}
const image = index => ({ name: `image-${index}.png`, dataUrl: 'data:image/png;base64,AAAA' });

test('on-demand image loads deduplicate in-flight requests and reuse cached images', async t => {
  const response = Promise.withResolvers();
  let calls = 0;
  const cache = cacheFixture(t, () => { calls++; return response.promise; });
  const first = cache.loadAttachment('s', 'm', 1);
  const second = cache.loadAttachment('s', 'm', 1);
  assert.equal(calls, 1);
  response.resolve(image(1));
  assert.equal(await first, await second);
  await cache.loadAttachment('s', 'm', 1);
  assert.equal(calls, 1);
});

test('the small LRU evicts the least recently used image and also enforces its data budget', async t => {
  let calls = 0;
  const cache = cacheFixture(t, async (_s, _m, index) => { calls++; return image(index); });
  for (let index = 0; index < 12; index++) await cache.loadAttachment('s', 'm', index);
  await cache.loadAttachment('s', 'm', 0);
  await cache.loadAttachment('s', 'm', 12);
  assert.equal(cache.cachedAttachment('s', 'm', 1), undefined);
  assert.ok(cache.cachedAttachment('s', 'm', 0));
  assert.equal(calls, 13);
  const large = cacheFixture(t, async (_s, _m, index) => ({ ...image(index), dataUrl: 'A'.repeat(9 * 1024 * 1024) }));
  await large.loadAttachment('s', 'm', 0);
  await large.loadAttachment('s', 'm', 1);
  assert.equal(large.cachedAttachment('s', 'm', 0), undefined);
  assert.ok(large.cachedAttachment('s', 'm', 1));
});

test('failed image loads can be retried', async t => {
  let calls = 0;
  const cache = cacheFixture(t, async () => { if (++calls === 1) throw new Error('offline'); return image(0); });
  await assert.rejects(cache.loadAttachment('s', 'm', 0), /offline/);
  assert.equal((await cache.loadAttachment('s', 'm', 0)).name, 'image-0.png');
});

test('AttachmentImage waits for visibility and a click opens the full image on demand', async t => {
  const previous = globalThis.IntersectionObserver;
  let observer;
  globalThis.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; observer = this; }
    observe() {}
    disconnect() {}
  };
  t.after(() => { globalThis.IntersectionObserver = previous; });
  const slots = [], effects = [], opened = [], requested = [];
  let index = 0;
  const react = {
    useRef(initial) { return slots[index++] ??= { current: initial }; },
    useState(initial) {
      const i = index++;
      slots[i] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slots[i].value, next => { slots[i].value = next; }];
    },
    useEffect(effect) { effects.push(effect); },
  };
  const { AttachmentImage } = loadModule(new URL('../src/renderer/react/AttachmentImage.tsx', import.meta.url).pathname, {
    react,
    './attachment-cache': { cachedAttachment: () => undefined, loadAttachment: async (...args) => { requested.push(args); return image(1); } },
  });
  const props = { sessionId: 's', messageId: 'm', index: 1, attachment: { name: 'image-1.png', hasData: true }, onOpenLightbox: value => opened.push(value) };
  const render = () => { index = 0; return AttachmentImage(props); };
  const button = render();
  button.props.ref.current = {};
  const cleanup = effects.shift()();
  assert.equal(requested.length, 0);
  observer.callback([{ isIntersecting: false }]);
  assert.equal(requested.length, 0);
  await button.props.onClick();
  await new Promise(setImmediate);
  assert.deepEqual(requested, [['s', 'm', 1]], 'uses the original attachment index, including file chips');
  assert.deepEqual(opened, [{ src: image(1).dataUrl, name: 'image-1.png' }]);
  const loaded = render();
  assert.equal(loaded.props.children.props.src, image(1).dataUrl);
  cleanup();
});
