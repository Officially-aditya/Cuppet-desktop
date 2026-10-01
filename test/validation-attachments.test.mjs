import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAttachments } from '../src/runtime/pe3/router.mjs';

test('normalizeAttachments accepts valid attachments with metadata and dataUrl', () => {
  const input = [
    {
      name: 'screenshot.png',
      mime: 'image/png',
      size: 1024.9,
      path: '/tmp/screenshot.png',
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    },
    {
      name: 'document.pdf',
      mime: 'application/pdf',
      size: 2048,
      path: '/docs/doc.pdf',
    },
  ];

  const result = normalizeAttachments(input);
  assert.equal(result.length, 2);
  assert.equal(result[0].name, 'screenshot.png');
  assert.equal(result[0].mime, 'image/png');
  assert.equal(result[0].size, 1024); // truncated to integer
  assert.equal(result[0].path, '/tmp/screenshot.png');
  assert.equal(result[0].dataUrl, input[0].dataUrl);

  assert.equal(result[1].name, 'document.pdf');
  assert.equal(result[1].mime, 'application/pdf');
  assert.equal(result[1].size, 2048);
  assert.equal(result[1].path, '/docs/doc.pdf');
  assert.equal(result[1].dataUrl, undefined);
});

test('normalizeAttachments supports all valid image MIME formats for dataUrl', () => {
  const mimeTypes = ['png', 'jpeg', 'webp', 'gif', 'svg+xml'];
  for (const ext of mimeTypes) {
    const dataUrl = `data:image/${ext};base64,AQIDBA==`;
    const result = normalizeAttachments([{ name: `test.${ext}`, mime: `image/${ext}`, dataUrl }]);
    assert.equal(result.length, 1);
    assert.equal(result[0].dataUrl, dataUrl);
  }
});

test('normalizeAttachments rejects invalid or dangerous dataUrl schemes', () => {
  const invalid = [
    { name: 'script.js', dataUrl: 'javascript:alert(1)' },
    { name: 'file.txt', dataUrl: 'data:text/plain;base64,SGVsbG8=' },
    { name: 'not-base64.png', dataUrl: 'data:image/png;utf8,hello' },
    { name: 'malformed.png', dataUrl: 'data:image/png;base64,***invalid***' },
  ];

  for (const item of invalid) {
    const result = normalizeAttachments([item]);
    // Since item has a name, it may be kept, but dataUrl MUST be stripped
    if (result.length > 0) {
      assert.equal(result[0].dataUrl, undefined, `Expected dataUrl to be stripped for ${item.name}`);
    }
  }
});

test('normalizeAttachments strips oversized dataUrl (> 20 MB)', () => {
  // Construct a pseudo data URI larger than 20 MB
  const header = 'data:image/png;base64,';
  const oversizedDataUrl = header + 'A'.repeat(20 * 1024 * 1024 + 10);
  const result = normalizeAttachments([{ name: 'huge.png', dataUrl: oversizedDataUrl }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'huge.png');
  assert.equal(result[0].dataUrl, undefined);
});

test('normalizeAttachments clamps maximum attachments to 16', () => {
  const items = Array.from({ length: 25 }, (_, i) => ({
    name: `file_${i}.txt`,
    size: 100,
  }));

  const result = normalizeAttachments(items);
  assert.equal(result.length, 16);
  assert.equal(result[0].name, 'file_0.txt');
  assert.equal(result[15].name, 'file_15.txt');
});

test('normalizeAttachments rejects empty or invalid records', () => {
  assert.deepEqual(normalizeAttachments(null), []);
  assert.deepEqual(normalizeAttachments(undefined), []);
  assert.deepEqual(normalizeAttachments('not-an-array'), []);
  assert.deepEqual(normalizeAttachments([{}]), []);
  assert.deepEqual(normalizeAttachments([null, undefined, 42, 'string']), []);
  // Item with only invalid mime and no name or path
  assert.deepEqual(normalizeAttachments([{ mime: 'invalid-mime-format' }]), []);
});
