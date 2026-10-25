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
  const toggle = document.querySelector('.trace-card-toggle') as HTMLButtonElement;
  if (toggle.getAttribute('aria-expanded') === 'false') flushSync(() => toggle.click());
}

(window as any).exerciseTraceCard = () => {
  const startedAt = Date.now() - 12000;
  let live = true;
  let items: any[] = [
    { id: 'thought', type: 'reasoning', text: '**Checking the implementation**\nDetailed reasoning stays available on demand.', sequence: 1, startedAt },
    { id: 'read', type: 'tool', tool: 'read_file', argumentsJson: '{"path":"src/app.ts"}', status: 'complete', sequence: 2 },
    { id: 'cmd', type: 'tool', tool: 'bash', argumentsJson: '{"command":"npm test"}', status: 'running', sequence: 3 },
  ];
  const render = () => flushSync(() => root.render(<main className="main-pane react-main-pane"><ChatTranscript key="trace-card" session={{ id: 'trace-card', messages: [{
    id: 'card-answer', role: 'assistant', content: live ? '' : 'The implementation and tests are ready.', status: live ? 'streaming' : 'stopped', createdAt: startedAt, updatedAt: startedAt + 12000,
  }] } as any} project={null} running={live} transcript={{ 'card-answer': { items, preview: '' } }} onInspectDiff={noop} onOpenLightbox={noop} /></main>));
  const card = () => document.querySelector('.trace-card-toggle') as HTMLButtonElement;
  render();
  if (card().getAttribute('aria-expanded') !== 'false' || document.querySelector('.message-trace')) throw new Error('Live card was not collapsed');
  if (!card().textContent?.includes('Checking the implementation') || !card().textContent?.includes('Read 1 file')) throw new Error('Live summary is missing');
  openTrace();
  if (!document.querySelector('.message-reasoning-preview')?.textContent?.includes('Checking the implementation')) throw new Error('Thought preview is missing');
  const group = document.querySelector('.trace-group-toggle') as HTMLButtonElement;
  if (group.getAttribute('aria-expanded') !== 'false' || document.querySelector('.thread-tool-row')) throw new Error('Tool group was not collapsed');
  flushSync(() => group.click());
  const firstTool = document.querySelector('.thread-tool-row');
  items = [...items, { id: 'read-2', type: 'tool', tool: 'read_file', argumentsJson: '{"path":"src/tests.ts"}', status: 'complete', sequence: 4 }];
  render();
  if (card().getAttribute('aria-expanded') !== 'true' || document.querySelector('.trace-group-toggle') !== group || group.getAttribute('aria-expanded') !== 'true') throw new Error('Streaming reset an open disclosure');
  if (firstTool !== document.querySelector('.thread-tool-row')) throw new Error('Growing a group remounted its tools');
  if (!card().textContent?.includes('Read 2 files')) throw new Error('Live counts did not update');
  flushSync(() => card().click());
  items = items.map(item => item.id === 'cmd' ? { ...item, status: 'error', details: 'Test command failed' } : item);
  render();
  if (card().getAttribute('aria-expanded') !== 'false' || !document.querySelector('.trace-failure-count')?.textContent?.includes('1 failed')) throw new Error('A collapsed card hid a failure or reopened');
  openTrace();
  if (!document.querySelector('.trace-group-toggle .trace-failure-count')) throw new Error('A collapsed tool group hid its failure');
  live = false;
  render();
  if (card().getAttribute('aria-expanded') !== 'false' || !card().textContent?.includes('Stopped after 12s')) throw new Error('A stopped turn did not fold with a stable duration');
  if (!document.querySelector('.message-content')?.textContent?.includes('The implementation and tests are ready.')) throw new Error('Folding hid the answer');
  return { collapsedLiveCard: true, liveCounts: true, stableGroups: true, manualToggle: true, visibleFailures: true, stoppedDuration: true };
};

let polishItems: any[] = [];
function renderPolish(id = 'polish-live', live = true) {
  flushSync(() => root.render(<main className="main-pane react-main-pane"><ChatTranscript key={id} session={{ id, messages: [{
    id, role: 'assistant', content: live ? '' : 'Finished.', status: live ? 'streaming' : 'complete', createdAt: 1000, updatedAt: 13000,
  }] } as any} project={null} running={live} transcript={{ [id]: { items: polishItems, preview: '' } }} onInspectDiff={noop} onOpenLightbox={noop} /></main>));
}
const waitForPolish = async (predicate: () => boolean) => {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('Trace polish update timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
const readTool = (id: number, status = 'complete') => ({ id: `read-${id}`, type: 'tool', tool: 'read_file', argumentsJson: JSON.stringify({ path: `file-${id}.ts` }), status, sequence: id });
function assertStaticMotion() {
  const title = document.querySelector('.trace-card-title')!;
  if (getComputedStyle(title).animationName !== 'none' || getComputedStyle(title).backgroundImage !== 'none') throw new Error('Reduced motion left the shimmer active');
  for (const node of document.querySelectorAll('.trace-text-added')) if (getComputedStyle(node).animationName !== 'none') throw new Error('Reduced motion animated the text');
  for (const node of document.querySelectorAll('.trace-text-removed')) if (getComputedStyle(node).display !== 'none') throw new Error('Reduced motion exposed old text');
}

(window as any).exerciseTracePolish = async () => {
  for (const id of ['polish-live', 'polish-other']) localStorage.removeItem(`cuppet.desktop.trace.${id}`);
  polishItems = [readTool(1, 'running')];
  renderPolish();
  const container = document.querySelector('.trace-card') as HTMLElement;
  const title = document.querySelector('.trace-card-title')!;
  await waitForPolish(() => container.dataset.traceVisible === 'true');
  if (getComputedStyle(title).animationName !== 'trace-shimmer' || getComputedStyle(title).animationPlayState !== 'running') throw new Error('Visible live header did not shimmer');
  polishItems = [readTool(1)]; renderPolish();
  if (title.textContent !== 'Read file-1.ts' || !title.querySelector('.trace-text-removed')) throw new Error('Tool completion did not morph the label');
  polishItems = [...polishItems, readTool(2)]; renderPolish();
  polishItems = [...polishItems, readTool(3)]; renderPolish();
  const changedCount = document.querySelector('.trace-card-meta .trace-text-added')!;
  if (changedCount.textContent !== '3' || getComputedStyle(changedCount).animationName !== 'trace-text-in') throw new Error(`Counts did not animate only the changed number: ${changedCount.textContent}, ${getComputedStyle(changedCount).animationName}`);
  document.body.classList.add('reduce-motion');
  polishItems = [...polishItems, readTool(4)]; renderPolish();
  assertStaticMotion();
  document.body.classList.remove('reduce-motion');

  const messages = document.querySelector('.messages') as HTMLElement;
  messages.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
  const spacer = document.createElement('div');
  spacer.style.height = '2000px'; spacer.style.flex = '0 0 2000px';
  messages.prepend(spacer);
  messages.scrollTop = 0;
  await waitForPolish(() => container.dataset.traceVisible === 'false');
  if (getComputedStyle(title).animationPlayState !== 'paused') throw new Error('Offscreen shimmer did not pause');
  container.scrollIntoView();
  await waitForPolish(() => container.dataset.traceVisible === 'true');
  spacer.remove();

  openTrace();
  renderPolish('polish-other');
  if (document.querySelector('.trace-card-toggle')?.getAttribute('aria-expanded') !== 'false') throw new Error('Disclosure state leaked between messages');
  renderPolish();
  if (document.querySelector('.trace-card-toggle')?.getAttribute('aria-expanded') !== 'true') throw new Error('Live disclosure did not restore after switching chats');
  renderPolish('polish-live', false);
  if (document.querySelector('.trace-card-toggle')?.getAttribute('aria-expanded') !== 'false') throw new Error('Persisted live state prevented the completion fold');
  openTrace();
  renderPolish('polish-other', false);
  renderPolish('polish-live', false);
  if (document.querySelector('.trace-card-toggle')?.getAttribute('aria-expanded') !== 'true') throw new Error('Finished disclosure did not restore after switching chats');
  return { labelMorph: true, animatedCounts: true, offscreenShimmerPaused: true, appReducedMotion: true, persistedLiveAndFinishedState: true };
};
(window as any).exerciseSystemTraceMotion = async () => {
  polishItems = [readTool(1, 'running')]; renderPolish('polish-motion');
  await waitForPolish(() => document.querySelector<HTMLElement>('.trace-card')?.dataset.traceVisible === 'true');
  polishItems = [readTool(1)]; renderPolish('polish-motion');
  assertStaticMotion();
  return { systemReducedMotion: true };
};
(window as any).restoreTraceDisclosure = () => {
  polishItems = [readTool(1)]; renderPolish('polish-live', false);
  if (document.querySelector('.trace-card-toggle')?.getAttribute('aria-expanded') !== 'true') throw new Error('Disclosure preference did not survive a reload');
  return { persistedAcrossReload: true };
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
  const button = document.querySelector('.message-reasoning-toggle') as HTMLButtonElement;
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
  const toggle = document.querySelector('.message-reasoning-toggle') as HTMLButtonElement;
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
