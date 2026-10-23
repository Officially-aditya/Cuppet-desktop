import assert from 'node:assert/strict';
import test from 'node:test';
import { createMarkdownCache } from '../src/renderer/react/markdown-cache.ts';

function fixture(limit) {
  const calls = [];
  return { calls, render: createMarkdownCache((source) => { calls.push(source); return `<p>${source}</p>`; }, limit) };
}

test('reopening the same markdown reuses its HTML, including empty content', () => {
  const { calls, render } = fixture();
  for (const text of ['a thought', '']) {
    assert.equal(render(text), `<p>${text}</p>`);
    assert.equal(render(text), `<p>${text}</p>`);
  }
  assert.deepEqual(calls, ['a thought', '']);
});

test('the cache evicts its oldest entries and leaves frequently reopened content', () => {
  const { calls, render } = fixture(400);
  const text = (letter) => letter.repeat(40); // 87 characters per entry; four fit.
  for (const letter of 'abcade') render(text(letter));
  calls.length = 0;
  for (const letter of 'acde') render(text(letter));
  assert.deepEqual(calls, []);
  render(text('b'));
  assert.deepEqual(calls, [text('b')]);
});

test('one oversized thought cannot flush the rest of the cache', () => {
  const { calls, render } = fixture(1000);
  render('small');
  const large = 'x'.repeat(2000);
  render(large);
  render(large);
  render('small');
  assert.deepEqual(calls, ['small', large, large]);
});
