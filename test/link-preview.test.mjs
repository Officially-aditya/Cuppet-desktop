import test from 'node:test';
import assert from 'node:assert/strict';
import { createLinkPreviewLoader, parseLinkPreview } from '../src/main/link-preview.mjs';

const publicHost = async () => [{ address: '93.184.215.14', family: 4 }];
const response = (body, type = 'text/html') => ({ status: 200, headers: { 'content-type': type }, body: Buffer.from(body) });

test('social metadata prefers Open Graph, decodes entities and resolves relative images', () => {
  const preview = parseLinkPreview(`<head>
    <title>Fallback</title>
    <meta content="Social &amp; Preview" property="og:title">
    <meta property='og:description' content='A > B &quot;quoted&quot; &#x1f680;'>
    <meta name="twitter:title" content="Twitter fallback">
    <meta property="og:site_name" content="Example">
    <meta property="og:image" content="../cover.png">
    <link rel="shortcut icon" href="/icon.png">
    </head><body><meta property="og:title" content="Wrong body title"></body>`, 'https://example.com/posts/one#section');
  assert.equal(preview.title, 'Social & Preview');
  assert.equal(preview.description, 'A > B "quoted" 🚀');
  assert.equal(preview.image, 'https://example.com/cover.png');
  assert.equal(preview.icon, 'https://example.com/icon.png');
  assert.equal(preview.url, 'https://example.com/posts/one');
  assert.equal(preview.siteName, 'Example');
});

test('preview falls back to document metadata and rejects executable image URLs', () => {
  const preview = parseLinkPreview('<title>Plain &amp; Simple</title><meta name="description" content="Useful page"><meta property="og:image" content="javascript:alert(1)">', 'https://example.com');
  assert.equal(preview.title, 'Plain & Simple');
  assert.equal(preview.description, 'Useful page');
  assert.equal(preview.image, null);
});

test('native previews return data images and reuse simultaneous and cached requests', async () => {
  const calls = [];
  const load = createLinkPreviewLoader({ resolveHost: publicHost,
    requestResource: async (url, options) => {
      calls.push(url.href);
      assert.deepEqual(options.addresses, await publicHost());
      return url.pathname === '/page' ? response('<title>Preview</title><meta property="og:image" content="/cover.png"><link rel="icon" href="/favicon.png">') : response('image', 'image/png');
    },
  });
  const [first, second] = await Promise.all([load('https://example.com/page#one'), load('https://example.com/page#two')]);
  assert.deepEqual(first, second);
  assert.equal(first.image, 'data:image/png;base64,aW1hZ2U=');
  assert.equal(first.icon, 'data:image/png;base64,aW1hZ2U=');
  assert.equal(calls.length, 3);
  await load('https://example.com/page');
  assert.equal(calls.length, 3);
});

test('preview fetching blocks local, private and mapped addresses before any request', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '::1', '::ffff:127.0.0.1', 'fd00::1']) {
    const load = createLinkPreviewLoader({ resolveHost: async () => [{ address, family: address.includes(':') ? 6 : 4 }], requestResource: async () => assert.fail('Private addresses must never be fetched') });
    await assert.rejects(load('https://example.com/page'), /public/);
  }
  const load = createLinkPreviewLoader();
  for (const url of ['file:///etc/passwd', 'https://user:secret@example.com', 'http://localhost/']) await assert.rejects(load(url), /public/);
});

test('redirect targets are validated and unavailable images leave usable text metadata', async () => {
  let calls = 0;
  const load = createLinkPreviewLoader({ resolveHost: publicHost,
    requestResource: async () => { calls++; return { status: 302, headers: { location: 'http://127.0.0.1/private' }, body: Buffer.alloc(0) }; },
  });
  await assert.rejects(load('https://example.com/page'), /public/);
  assert.equal(calls, 1);
  const textOnly = createLinkPreviewLoader({ resolveHost: publicHost,
    requestResource: async url => url.pathname === '/page' ? response('<title>Useful</title><meta property="og:image" content="/private.png">') : response('not an image', 'text/html'),
  });
  const preview = await textOnly('https://example.com/page');
  assert.equal(preview.title, 'Useful');
  assert.equal(preview.image, null);
  assert.equal(preview.icon, null);
});

test('failed page requests can be retried rather than cached as successful previews', async () => {
  let calls = 0;
  const load = createLinkPreviewLoader({ resolveHost: publicHost,
    requestResource: async () => { if (++calls === 1) throw new Error('offline'); return response('<title>Recovered</title>'); },
  });
  await assert.rejects(load('https://example.com/page'), /offline/);
  assert.equal((await load('https://example.com/page')).title, 'Recovered');
});
