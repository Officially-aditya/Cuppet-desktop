import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_PROMPT_TEXT, validateAttachments, validateCommandInput } from '../src/main/command-input.mjs';

const STEER = 'cuppet.steer.interrupt';
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

test('a steered prompt is delivered whole instead of being cut to the command-argument limit', () => {
  const long = 'additional guidance '.repeat(2000).trim(); // ~40k characters
  assert.equal(validateCommandInput({ text: long }, STEER).text, long);
});

test('a steered prompt still has the same ceiling as a normal prompt', () => {
  assert.equal(validateCommandInput({ text: 'x'.repeat(MAX_PROMPT_TEXT + 500) }, STEER).text.length, MAX_PROMPT_TEXT);
});

test('other commands keep the short argument limit', () => {
  const long = 'y'.repeat(20000);
  assert.equal(validateCommandInput({ text: long }, 'cuppet.compact').text.length, 8192);
  assert.equal(validateCommandInput({ text: long }).text.length, 8192);
});

test('steer text is trimmed and input that is not an object is ignored', () => {
  assert.equal(validateCommandInput({ text: '  keep going  ' }, STEER).text, 'keep going');
  for (const bad of [null, undefined, 'text', 7, ['text']]) assert.deepEqual(validateCommandInput(bad, STEER), {});
});

test('steered attachments get the same validation as attachments on a normal send', () => {
  const input = validateCommandInput({ text: 'look', attachments: [
    { name: 'shot.png', mime: 'image/png', dataUrl: PNG, size: 12.9 },
    { name: 'evil.svg', dataUrl: 'javascript:alert(1)' },
    { dataUrl: 'data:text/html;base64,PGgxPg==' },
    { path: '/tmp/notes.txt' },
    null,
    'not an object',
  ] }, STEER);
  assert.deepEqual(input.attachments, [
    { name: 'shot.png', mime: 'image/png', dataUrl: PNG, size: 12 },
    { name: 'evil.svg' },
    { path: '/tmp/notes.txt' },
  ]);
});

test('attachments are capped in count and field length', () => {
  const many = Array.from({ length: 40 }, (_, index) => ({ name: `file-${index}.txt` }));
  assert.equal(validateAttachments(many).length, 16);
  const [item] = validateAttachments([{ name: 'n'.repeat(500), mime: 'm'.repeat(500), path: 'p'.repeat(2000) }]);
  assert.deepEqual([item.name.length, item.mime.length, item.path.length], [240, 128, 512]);
  assert.deepEqual(validateAttachments('nope'), []);
  assert.equal(validateAttachments([{ name: 'a.png', dataUrl: `data:image/png;base64,${'A'.repeat(21 * 1024 * 1024)}` }])[0].dataUrl, undefined, 'oversized images are dropped but the file entry is kept');
});

test('other command fields keep their existing validation', () => {
  assert.deepEqual(validateCommandInput({ key: ' k ', value: ' v ', scope: 'project', mode: 'plan', pinned: true, extra: 'ignored' }), {
    key: 'k', value: 'v', scope: 'project', mode: 'plan', pinned: true,
  });
  assert.deepEqual(validateCommandInput({ scope: 'galaxy', mode: 'turbo', pinned: 'yes' }), {});
});
