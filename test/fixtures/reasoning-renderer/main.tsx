import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ChatTranscript } from '../../../src/renderer/react/ChatTranscript';
import '../../../src/renderer/index.css';

const root = createRoot(document.getElementById('root')!);
const noop = () => {};
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
  await new Promise(resolve => setTimeout(resolve, 30));
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
