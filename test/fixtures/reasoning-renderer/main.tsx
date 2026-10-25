import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ChatTranscript } from '../../../src/renderer/react/ChatTranscript';
import '../../../src/renderer/index.css';
import { appendMarkdownText, updateMarkdownTail } from '../../../src/renderer/react/markdown-tail';
import { renderMarkdown } from '../../../src/renderer/react/markdown';

const root = createRoot(document.getElementById('root')!);
const noop = () => {};
function openTrace() {
  const toggle = document.querySelector('.message-cuppet-toggle') as HTMLButtonElement;
  if (toggle.getAttribute('aria-expanded') === 'false') flushSync(() => toggle.click());
}

const inlineItems = () => [
  { id: 'commentary-1', type: 'reasoning', kind: 'commentary', text: 'I’ll check the transcript renderer and how activity is grouped.', sequence: 1, completedAt: 2000 },
  { id: 'read', type: 'tool', tool: 'read_file', argumentsJson: '{"path":"src/renderer/react/ChatTranscript.tsx"}', status: 'complete', sequence: 2 },
  { id: 'test', type: 'tool', tool: 'bash', argumentsJson: '{"command":"npm test"}', status: 'complete', sequence: 3 },
  { id: 'commentary-2', type: 'reasoning', kind: 'commentary', text: 'The output can stay inline, with tool calls tucked under each work step.', sequence: 4, completedAt: 4000 },
  { id: 'thought', type: 'reasoning', text: 'Private reasoning with **formatting** and `src/app.ts`.', sequence: 5 },
];
function renderInline(items: any[], live = true, id = 'inline-activity') {
  flushSync(() => root.render(<main className="main-pane react-main-pane"><ChatTranscript key={id} session={{ id, messages: [{
    id, role: 'assistant', content: live ? '' : 'The transcript layout is updated.', status: live ? 'streaming' : 'complete', createdAt: 1000, updatedAt: 13000,
  }] } as any} project={null} running={live} transcript={{ [id]: { items, preview: '' } }} onInspectDiff={noop} onOpenLightbox={noop} /></main>));
}
(window as any).exerciseInlineActivity = () => {
  localStorage.removeItem('cuppet.desktop.trace.inline-activity');
  let items: any[] = inlineItems();
  renderInline(items);
  const cuppet = () => document.querySelector('.message-cuppet-toggle') as HTMLButtonElement;
  if (document.querySelector('.trace-card') || cuppet().getAttribute('aria-expanded') !== 'true') throw new Error('The original Cuppet disclosure was not restored');
  const rows = [...document.querySelector('.message-trace')!.children];
  if (rows.length !== 4 || !rows[0].textContent?.includes('I’ll check') || rows[1].textContent !== 'Worked' || !rows[2].textContent?.includes('The output can stay inline') || rows[3].textContent !== 'Thinking…') throw new Error('Text and work intervals are out of order');
  if (document.querySelector('.thread-tool-row') || document.querySelector('.message-reasoning-content')) throw new Error('A collapsed work step exposed its internals');
  const first = rows[1].querySelector('button') as HTMLButtonElement;
  flushSync(() => first.click());
  const firstTool = rows[1].querySelector('.thread-tool-row');
  if (rows[1].querySelectorAll('.thread-tool-row').length !== 2 || rows[3].querySelector('.thread-tool-row')) throw new Error('Work expansion included another interval');
  items = [...items, { id: 'next-tool', type: 'tool', tool: 'read_file', argumentsJson: '{"path":"src/app.ts"}', status: 'running', sequence: 6 }];
  renderInline(items);
  if (rows[1].querySelector('.thread-tool-row') !== firstTool || first.getAttribute('aria-expanded') !== 'true' || rows[3].querySelector('button')?.textContent !== 'Working…') throw new Error('Streaming reset an interval or its label');
  flushSync(() => first.click());
  items = items.map(item => item.id === 'test' ? { ...item, status: 'error', details: 'Test failure' } : item);
  renderInline(items);
  if (!first.textContent?.includes('1 failed')) throw new Error('A collapsed step hid a failure');
  flushSync(() => cuppet().click());
  renderInline(items);
  if (document.querySelector('.message-trace') || !document.querySelector('.message-role .trace-failure-count')) throw new Error('Cuppet did not fold the trace or hid a failure');
  renderInline(items, true, 'another-message');
  renderInline(items);
  if (cuppet().getAttribute('aria-expanded') !== 'false') throw new Error('A manually closed live trace did not stay closed');
  openTrace();
  renderInline(items, false);
  if (cuppet().getAttribute('aria-expanded') !== 'false' || !cuppet().textContent?.includes('Worked for 12s') || !document.querySelector('.message-content')?.textContent?.includes('The transcript layout is updated')) throw new Error('Completion changed the Cuppet summary behavior');
  openTrace();
  renderInline(items, false, 'another-message');
  renderInline(items, false);
  if (cuppet().getAttribute('aria-expanded') !== 'true') throw new Error('Finished Cuppet disclosure did not restore');
  return { originalCuppetToggle: true, inlineProgress: true, orderedIntervals: true, toolsHiddenByDefault: true, independentExpansion: true, stableStreaming: true, visibleFailures: true, persistedDisclosure: true };
};
(window as any).restoreInlineDisclosure = () => {
  renderInline(inlineItems(), false);
  if (document.querySelector('.message-cuppet-toggle')?.getAttribute('aria-expanded') !== 'true') throw new Error('Cuppet disclosure did not survive a reload');
  return { persistedAcrossReload: true };
};
(window as any).showInlinePreview = () => {
  localStorage.removeItem('cuppet.desktop.trace.inline-preview');
  renderInline(inlineItems(), true, 'inline-preview');
};

let updateThought: (text: string, complete: boolean) => void;
(window as any).setThought = (count: number, live = false) => {
  const text = Array.from({ length: count }, (_, i) => `### Investigation ${i}\n\nReviewing the **current implementation** and how it changes the user prompt, tool result and transcript state. Check \`src/renderer/react/ChatTranscript.tsx\` and preserve links to [the source](https://example.com/source).\n\n\`\`\`typescript\nconst item${i} = { content: 'some value', sequence: ${i} };\nconsole.log(item${i});\n\`\`\`\n`).join('\n');
  let items: any[] = Array.from({ length: 100 }, (_, i) => i === 0
    ? { id: 'reasoning', type: 'reasoning', text, sequence: 1, startedAt: 1, completedAt: live ? undefined : 2 }
    : { id: `tool-${i}`, type: 'tool', tool: 'read_file', status: 'complete', argumentsJson: JSON.stringify({ path: `file${i}.ts` }), sequence: i + 1 });
  const session: any = { id: `chat-${count}-${live}`, messages: [{ id: 'answer', sessionId: 'chat', role: 'assistant', content: '', status: live ? 'streaming' : 'stopped', createdAt: 1, updatedAt: 2 }] };
  const render = () => flushSync(() => root.render(<main className="main-pane react-main-pane"><ChatTranscript key={session.id} session={session} project={null} running={live} transcript={{ answer: { items, preview: '' } }} onInspectDiff={noop} onOpenLightbox={noop} /></main>));
  updateThought = (text, complete) => {
    items = [{ ...items[0], text: items[0].text + text, completedAt: complete ? 2 : undefined }, ...items.slice(1)];
    render();
  };
  render();
  return text.length;
};
(window as any).runToggle = async () => {
  openTrace();
  const button = document.querySelector('.message-work-toggle') as HTMLButtonElement;
  const longTasks: number[] = [];
  const observer = new PerformanceObserver((list) => longTasks.push(...list.getEntries().map(entry => entry.duration)));
  observer.observe({ type: 'longtask' });
  const gaps: number[] = [];
  let last = performance.now();
  const timer = setInterval(() => { const now = performance.now(); gaps.push(now - last); last = now; }, 10);
  const start = performance.now();
  button.click();
  const dispatchMs = performance.now() - start;
  const deadline = performance.now() + 20_000;
  while (!document.querySelector('.message-reasoning-content:not([hidden])') || document.querySelector('.message-reasoning-content')!.getAttribute('aria-busy') === 'true') {
    if (performance.now() > deadline) throw new Error('Reasoning render timed out');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  document.querySelector('.messages')!.getBoundingClientRect();
  await new Promise(resolve => setTimeout(resolve, 30));
  const shownMs = performance.now() - start;
  await new Promise(resolve => setTimeout(resolve, 80));
  clearInterval(timer);
  observer.disconnect();
  const elements = document.querySelectorAll('*').length;
  button.click();
  // Finish this collapse before a separate profile starts timing the next open.
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return { dispatchMs, shownMs, maxGap: Math.max(...gaps), longTasks, elements };
};

(window as any).updateThought = (text: string, complete = false) => updateThought(text, complete);
(window as any).exerciseStreaming = async () => {
  const wait = async (predicate: () => boolean) => {
    const deadline = performance.now() + 20_000;
    while (!predicate()) {
      if (performance.now() > deadline) throw new Error('Reasoning update timed out');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  (window as any).setThought(200, true);
  openTrace();
  const toggle = document.querySelector('.message-work-toggle') as HTMLButtonElement;
  toggle.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  toggle.click();
  await wait(() => toggle.getAttribute('aria-expanded') === 'false');
  await new Promise(resolve => setTimeout(resolve, 80));
  if (!document.querySelector('.message-reasoning-content[hidden]')) throw new Error('Collapsed thought became visible');
  toggle.click();
  await wait(() => document.querySelector('.message-reasoning-content')?.getAttribute('aria-busy') === 'false');
  const range = document.createRange();
  range.selectNodeContents(document.querySelector('.message-reasoning-content code')!);
  getSelection()!.removeAllRanges();
  getSelection()!.addRange(range);
  const selection = getSelection()!.toString();
  for (let index = 0; index < 80; index++) {
    updateThought(`\n\nAdditional guidance ${index}.`, false);
    if (index % 10 === 9) await new Promise(resolve => setTimeout(resolve, 0));
  }
  updateThought('\n\n## Final guidance\n\nUse `src/final.ts` and **retain formatting**.\n', true);
  await wait(() => document.querySelector('.message-reasoning-content')?.getAttribute('aria-busy') === 'false');
  const content = document.querySelector('.message-reasoning-content')!;
  if (!content.textContent?.includes('Additional guidance 79.')) throw new Error('Latest streamed content was lost');
  if (!content.querySelector('strong') || !content.querySelector('code[data-cuppet-project-file="src/final.ts"]')) throw new Error('Final markdown lost formatting or links');
  if (!content.querySelector('.md-code-copy')) throw new Error('Code copy buttons were lost');
  if (getSelection()!.toString() !== selection) throw new Error('Streaming replaced selected text');
  return { collapseWhileLoading: true, latestStreamedContent: true, finalFormatting: true, projectLinks: true, codeCopyButtons: true, retainedSelection: true };
};

(window as any).exerciseMarkdownTail = () => {
  const cases: [string, string, boolean][] = [
    ['<p>Text <code>src/app.ts</code> suffix</p>', '<p>Text <code>src/app.ts</code> suffix next &amp; &lt;tag&gt; 😀</p>', true],
    ['<div><pre><code>line one</code></pre></div>', '<div><pre><code>line one\nline two &lt;x&gt;\n</code></pre></div>', true],
    ['<ul><li>first</li><li>last</li></ul>', '<ul><li>first</li><li>last appended</li></ul>', true],
    ['<p>Before <strong>bold</strong></p>', '<p>Before <strong>bold</strong> &amp; <code>src/new.ts</code></p>', true],
    ['<p>**bold</p>', '<p><strong>bold</strong></p>', true],
    ['<p>longer</p>', '<p>short</p>', true],
    ['<p>https://exa</p>', '<p><a href="https://example.com">https://example.com</a></p>', true],
    ['<table><tbody><tr><td>one</td></tr></tbody></table>', '<table><tbody><tr><td>one</td></tr><tr><td>two</td></tr></tbody></table>', true],
    ['<p>Value</p>', '<p>Value &lt;script&gt;bad()&lt;/script&gt;</p>', true],
    ['<p>Heading</p>', '<h2>Heading</h2>', false],
    ['<p><code class="before">text</code></p>', '<p><code class="after">text</code></p>', false],
  ];
  for (const [previous, next, fast] of cases) {
    const node = document.createElement('div');
    node.innerHTML = previous;
    const existing = [...node.querySelectorAll('*')];
    const appended = appendMarkdownText(node, previous, next);
    if (appended !== fast) throw new Error('Unexpected mutable-tail update path');
    if (appended && !existing.every(element => node.contains(element))) throw new Error('Appending text replaced existing markup');
    if (!appended) node.innerHTML = next;
    const expected = document.createElement('div');
    expected.innerHTML = next;
    if (!node.isEqualNode(expected)) throw new Error('Mutable-tail update changed text or structure');
    node.innerHTML = previous;
    updateMarkdownTail(node, previous, next);
    if (!node.isEqualNode(expected)) throw new Error('Tail reconciliation changed text or structure');
  }
  const node = document.createElement('div');
  let previous = '<p>Selected prefix <code>src/old.ts</code> **up</p>';
  node.innerHTML = previous;
  document.body.appendChild(node);
  const code = node.querySelector('code');
  const range = document.createRange();
  range.setStart(node.querySelector('p')!.firstChild!, 0);
  range.setEnd(node.querySelector('p')!.firstChild!, 8);
  getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
  for (const next of [
    '<p>Selected prefix <code>src/old.ts</code> <strong>update</strong> and `src/live</p>',
    '<p>Selected prefix <code>src/old.ts</code> <strong>update</strong> and <code>src/live.ts</code></p>',
  ]) {
    updateMarkdownTail(node, previous, next);
    const expected = document.createElement('div'); expected.innerHTML = next;
    if (!node.isEqualNode(expected) || node.querySelector('code') !== code || getSelection()!.toString() !== 'Selected') throw new Error('Partial formatting replaced the existing prefix');
    previous = next;
  }
  // Growing past a paragraph section boundary must preserve existing links and
  // selected text, and copied text must include sections outside the viewport.
  const response = document.createElement('article');
  response.className = 'message assistant message-preview';
  const responseContent = document.createElement('div');
  responseContent.className = 'message-content markdown-rendered';
  response.appendChild(responseContent);
  document.body.appendChild(response);
  responseContent.appendChild(node);
  node.className = 'markdown-block';
  let source = 'Selected prefix `src/old.ts` and **formatted text**. '.repeat(20);
  previous = renderMarkdown(source);
  node.innerHTML = previous;
  const retainedCode = node.querySelector('code');
  range.setStart(node.querySelector('p')!.firstChild!, 0);
  range.setEnd(node.querySelector('p')!.firstChild!, 8);
  getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
  for (const delta of [' More text and [a link](https://example.com). '.repeat(180), ' More **format', 'ting** and `src/new.ts`.']) {
    source += delta;
    const next = renderMarkdown(source);
    updateMarkdownTail(node, previous, next);
    const expected = document.createElement('div'); expected.innerHTML = next;
    if (node.innerHTML !== expected.innerHTML || node.querySelector('code') !== retainedCode || getSelection()!.toString() !== 'Selected') throw new Error('Paragraph section growth replaced content or selection');
    response.classList.remove('message-preview');
    if (node.innerText.replace(/\s+/g, ' ').trim() !== expected.textContent!.replace(/\s+/g, ' ').trim()) throw new Error('Copying a long paragraph omitted offscreen sections');
    response.classList.add('message-preview');
    previous = next;
  }
  response.remove();
  return { tailCases: cases.length, escapedText: true, retainedNodes: true, partialFormatting: true, paragraphSections: true };
};
