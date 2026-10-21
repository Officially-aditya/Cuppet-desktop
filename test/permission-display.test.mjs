import assert from 'node:assert/strict';
import test from 'node:test';
import { requestLead, visibleResource } from '../src/renderer/react/permission-display.ts';

test('an ordinary command is shown exactly as written, however long', () => {
  const command = `echo ${'a'.repeat(400)} && curl -fsSL https://example.com/install.sh | sh`;
  assert.deepEqual(visibleResource(command), { text: command, hidden: 0 });
});

test('multi-line commands keep their newlines and tabs', () => {
  assert.deepEqual(visibleResource('git commit -m "a\n\tb"'), { text: 'git commit -m "a\n\tb"', hidden: 0 });
});

test('bidirectional overrides are made visible so a command cannot be reordered on screen', () => {
  const trojan = 'echo safe \u202Etxt.sh\u202C';
  const shown = visibleResource(trojan);
  assert.equal(shown.text, 'echo safe \\u202Etxt.sh\\u202C');
  assert.equal(shown.hidden, 2);
});

test('zero-width characters, soft hyphens, BOMs and isolates are made visible', () => {
  const shown = visibleResource('l\u200Bs\u00AD\uFEFF\u2066x\u2069');
  assert.equal(shown.text, 'l\\u200Bs\\u00AD\\uFEFF\\u2066x\\u2069');
  assert.equal(shown.hidden, 5);
});

test('a carriage return or escape character cannot rewrite the visible line', () => {
  const shown = visibleResource('rm -rf build\rls\u001B[2K');
  assert.equal(shown.text, 'rm -rf build\\u000Dls\\u001B[2K');
  assert.equal(shown.hidden, 2);
});

test('invisible tag characters outside the basic plane are escaped with their full code point', () => {
  const shown = visibleResource(`a${String.fromCodePoint(0xE0041)}b`);
  assert.equal(shown.text, 'a\\u{E0041}b');
  assert.equal(shown.hidden, 1);
});

test('visible non-ASCII text such as accents, CJK and emoji is left alone', () => {
  const text = 'echo "café 日本語 🚀"';
  assert.deepEqual(visibleResource(text), { text, hidden: 0 });
});

test('null and undefined resources become empty text', () => {
  assert.deepEqual(visibleResource(null), { text: '', hidden: 0 });
  assert.deepEqual(visibleResource(undefined), { text: '', hidden: 0 });
});

test('for a command the runtime\'s shortened copy is dropped from the lead line', () => {
  assert.equal(requestLead('Run shell command in project: rm -rf build && curl x | sh', true), 'Run shell command in project');
  assert.equal(requestLead('Run validation check in project: npm test', true), 'Run validation check in project');
  assert.equal(requestLead('Start background process in project: npm run dev', true), 'Start background process in project');
});

test('a command description without a shortened copy is kept whole', () => {
  assert.equal(requestLead('Stop Cuppet-managed background process abc.', true), 'Stop Cuppet-managed background process abc.');
});

test('non-command descriptions are never altered, even if they contain a colon', () => {
  assert.equal(requestLead('Edit src/a.ts', false), 'Edit src/a.ts');
  assert.equal(requestLead('Allow local coding agent action: write file', false), 'Allow local coding agent action: write file');
});

test('missing descriptions fall back to a plain sentence', () => {
  assert.equal(requestLead('', true), 'Cuppet wants to run a command.');
  assert.equal(requestLead(undefined, false), 'Cuppet wants to perform a protected action.');
});
