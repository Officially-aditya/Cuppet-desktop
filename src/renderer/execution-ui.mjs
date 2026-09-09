import { renderMarkdown } from './markdown.mjs';

const prompt = document.querySelector('#prompt');
const composer = document.querySelector('#composer');
const composerWrap = document.querySelector('.composer-wrap');
const actions = composer?.querySelector('.composer-actions');
const messages = document.querySelector('#messages');
const sendButton = document.querySelector('#send-button');
const stopButton = document.querySelector('#stop-button');

if (prompt && composer && composerWrap && actions && messages && sendButton && stopButton && window.cuppet) {
  const running = new Set();
  const queues = new Map();
  const activity = new Map();
  let deliveryMode = 'queue';
  let rendering = false;

  const panel = document.createElement('section');
  panel.className = 'execution-activity hidden';
  panel.setAttribute('aria-label', 'Agent activity');
  composerWrap.insertBefore(panel, composer);

  const controls = document.createElement('div');
  controls.className = 'delivery-controls hidden';
  controls.innerHTML = '<span>While running</span>';
  const queueButton = modeButton('Queue', 'Queue this message until the current run finishes.', 'queue');
  const steerButton = modeButton('Steer', 'Interrupt the current run and immediately apply this instruction.', 'steer');
  controls.append(queueButton, steerButton);
  actions.insertBefore(controls, actions.firstChild);
  setDeliveryMode('queue');

  composer.addEventListener('submit', (event) => {
    const sessionId = currentSessionId();
    const text = prompt.value.trim();
    if (!sessionId || !text || text.startsWith('/') || !isRunning(sessionId)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    clearPrompt();
    if (deliveryMode === 'steer') void steer(sessionId, text);
    else enqueue(sessionId, text);
  }, true);

  stopButton.addEventListener('click', () => {
    const sessionId = currentSessionId();
    if (!sessionId) return;
    const removed = queues.get(sessionId)?.length ?? 0;
    if (removed) {
      queues.delete(sessionId);
      addActivity(sessionId, { id: `queue-cleared-${Date.now()}`, kind: 'queue', status: 'stopped', label: `Cleared ${removed} queued message${removed === 1 ? '' : 's'}` });
      renderActivity();
    }
  }, true);

  window.cuppet.onEvent((event) => {
    if (!event || typeof event.type !== 'string') return;
    const sessionId = String(event.sessionId ?? event.message?.sessionId ?? '');
    if (event.type === 'run.started' && sessionId) running.add(sessionId);
    if (event.type === 'run.finished' && sessionId) {
      running.delete(sessionId);
      setTimeout(() => void drainQueue(sessionId), 0);
    }
    if (event.type === 'tool.started' && sessionId) {
      addActivity(sessionId, { id: event.executionId, kind: 'tool', tool: event.tool, status: 'running', label: startedLabel(event.tool) });
    }
    if (event.type === 'tool.finished' && sessionId) void finishTool(sessionId, event);
    if (event.type === 'validation.completed' && sessionId) addValidation(sessionId, event.validation);
    if (event.type === 'message.delta' && event.messageId && sessionId === currentSessionId()) renderMessageById(event.messageId, event.content ?? '');
    if ((event.type === 'message.created' || event.type === 'message.completed') && event.message?.role === 'assistant' && event.message.sessionId === currentSessionId()) renderMessageById(event.message.id, event.message.content ?? '');
    queueMicrotask(() => { syncComposer(); renderActivity(); });
  });

  const bodyObserver = new MutationObserver(() => { syncComposer(); void loadActivityForCurrent(); renderVisibleMarkdown(); });
  bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['data-cuppet-session-id'] });

  const composerObserver = new MutationObserver(() => syncComposer());
  composerObserver.observe(prompt, { attributes: true, attributeFilter: ['disabled'] });
  composerObserver.observe(sendButton, { attributes: true, attributeFilter: ['disabled'] });
  composerObserver.observe(stopButton, { attributes: true, attributeFilter: ['class'] });

  const messageObserver = new MutationObserver(() => {
    if (rendering) return;
    renderVisibleMarkdown();
  });
  messageObserver.observe(messages, { childList: true, subtree: true });

  syncComposer();
  renderVisibleMarkdown();
  void loadActivityForCurrent();

  function modeButton(label, title, mode) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'delivery-mode-button';
    button.textContent = label;
    button.title = title;
    button.addEventListener('click', () => setDeliveryMode(mode));
    return button;
  }

  function setDeliveryMode(mode) {
    deliveryMode = mode === 'steer' ? 'steer' : 'queue';
    queueButton.classList.toggle('active', deliveryMode === 'queue');
    steerButton.classList.toggle('active', deliveryMode === 'steer');
    syncComposer();
  }

  function currentSessionId() { return String(document.body.dataset.cuppetSessionId || '').slice(0, 256); }
  function isRunning(sessionId) { return running.has(sessionId) || (sessionId === currentSessionId() && !stopButton.classList.contains('hidden')); }

  function syncComposer() {
    const activeRunning = isRunning(currentSessionId());
    controls.classList.toggle('hidden', !activeRunning);
    if (activeRunning) {
      prompt.disabled = false;
      sendButton.disabled = false;
      sendButton.textContent = deliveryMode === 'steer' ? 'Steer' : 'Queue';
      prompt.placeholder = deliveryMode === 'steer' ? 'Steer the active run…' : 'Queue a message for after the active run…';
    } else {
      sendButton.textContent = 'Send';
      prompt.placeholder = 'Message Cuppet…';
    }
  }

  function clearPrompt() {
    prompt.value = '';
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    prompt.focus();
  }

  function enqueue(sessionId, text) {
    const queue = queues.get(sessionId) ?? [];
    if (queue.length >= 16) {
      addActivity(sessionId, { id: `queue-limit-${Date.now()}`, kind: 'queue', status: 'error', label: 'Queue is full (16 messages)' });
      renderActivity();
      return;
    }
    const item = { id: `queued-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`, text: text.slice(0, 8192), createdAt: Date.now() };
    queue.push(item); queues.set(sessionId, queue);
    addActivity(sessionId, { id: item.id, kind: 'queue', status: 'queued', label: `Queued message #${queue.length}`, details: item.text });
    renderActivity();
  }

  async function drainQueue(sessionId) {
    if (isRunning(sessionId)) return;
    const queue = queues.get(sessionId);
    if (!queue?.length) return;
    const item = queue.shift();
    if (!queue.length) queues.delete(sessionId);
    updateActivity(sessionId, item.id, { status: 'running', label: 'Sending queued message' });
    renderActivity();
    try {
      const result = await window.cuppet.sessions.send(sessionId, item.text);
      updateActivity(sessionId, item.id, { status: 'complete', label: 'Queued message sent' });
      if (result?.sessionId) running.add(result.sessionId);
    } catch (error) {
      const remaining = queues.get(sessionId) ?? [];
      remaining.unshift(item); queues.set(sessionId, remaining);
      updateActivity(sessionId, item.id, { status: 'error', label: 'Queued message could not start', details: error?.message || String(error) });
    }
    renderActivity();
  }

  async function steer(sessionId, text) {
    const id = `steer-${Date.now()}`;
    addActivity(sessionId, { id, kind: 'queue', status: 'running', label: 'Interrupting and steering active run', details: text });
    renderActivity();
    try {
      await window.cuppet.commands.execute(sessionId, { id: 'cuppet.steer.interrupt', input: { text: text.slice(0, 8192) } });
      updateActivity(sessionId, id, { status: 'complete', label: 'Steer instruction accepted' });
    } catch (error) {
      updateActivity(sessionId, id, { status: 'error', label: 'Steer failed', details: error?.message || String(error) });
    }
    renderActivity();
  }

  async function finishTool(sessionId, event) {
    const existing = findActivity(sessionId, event.executionId) ?? { id: event.executionId, kind: 'tool', tool: event.tool };
    const patch = { status: event.success ? 'complete' : 'error', label: finishedLabel(event) };
    if (!event.success && event.message) patch.details = event.message;
    updateActivity(sessionId, existing.id, patch, existing);
    try {
      const session = await window.cuppet.sessions.get(sessionId);
      const execution = session?.toolExecutions?.find?.((item) => item.id === event.executionId);
      if (execution) {
        const parsedOutput = parseOutput(execution.output);
        updateActivity(sessionId, existing.id, {
          arguments: prettyJson(execution.argumentsJson),
          output: parsedOutput.output,
          diff: parsedOutput.diff,
          details: !event.success ? execution.output : undefined,
        });
      }
    } catch {}
    renderActivity();
  }

  function addValidation(sessionId, validation) {
    if (!validation) return;
    const commands = Array.isArray(validation.commands) ? validation.commands : [];
    const success = validation.success === true || (commands.length > 0 && commands.every((item) => item?.exitCode === 0));
    addActivity(sessionId, {
      id: `validation-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      kind: 'validation', status: success ? 'complete' : 'error',
      label: success ? `Validation passed${commands.length ? ` · ${commands.length} check${commands.length === 1 ? '' : 's'}` : ''}` : 'Validation failed',
      output: commands.map((item) => `${item.command ?? 'check'} → exit ${item.exitCode ?? '?'}`).join('\n'),
      details: JSON.stringify(validation, null, 2),
    });
    renderActivity();
  }

  function addActivity(sessionId, entry) {
    const list = activity.get(sessionId) ?? [];
    const index = list.findIndex((item) => item.id === entry.id);
    if (index >= 0) list[index] = { ...list[index], ...entry };
    else list.push(entry);
    activity.set(sessionId, list.slice(-30));
  }

  function updateActivity(sessionId, id, patch, fallback = null) {
    const list = activity.get(sessionId) ?? [];
    const index = list.findIndex((item) => item.id === id);
    if (index >= 0) list[index] = { ...list[index], ...patch };
    else list.push({ ...(fallback ?? { id }), ...patch });
    activity.set(sessionId, list.slice(-30));
  }

  function findActivity(sessionId, id) { return (activity.get(sessionId) ?? []).find((item) => item.id === id); }

  async function loadActivityForCurrent() {
    const sessionId = currentSessionId();
    if (!sessionId || activity.has(sessionId)) return;
    try {
      const session = await window.cuppet.sessions.get(sessionId);
      const entries = (session?.toolExecutions ?? []).slice(-20).map((execution) => {
        const parsed = parseOutput(execution.output);
        return {
          id: execution.id, kind: 'tool', tool: execution.toolName,
          status: execution.status === 'complete' ? 'complete' : execution.status === 'running' ? 'running' : 'error',
          label: historicalLabel(execution), arguments: prettyJson(execution.argumentsJson), output: parsed.output, diff: parsed.diff,
        };
      });
      if (entries.length) activity.set(sessionId, entries);
    } catch {}
    renderActivity();
  }

  function renderActivity() {
    const sessionId = currentSessionId();
    const list = sessionId ? activity.get(sessionId) ?? [] : [];
    const queued = sessionId ? queues.get(sessionId)?.length ?? 0 : 0;
    if (!list.length && !queued) { panel.classList.add('hidden'); panel.replaceChildren(); return; }
    const visible = list.slice(-12);
    panel.replaceChildren(...visible.map(activityNode));
    panel.classList.remove('hidden');
    panel.scrollTop = panel.scrollHeight;
  }

  function activityNode(entry) {
    const row = document.createElement('article');
    row.className = `activity-row ${entry.status || 'complete'}`;
    const head = document.createElement('div'); head.className = 'activity-head';
    const status = document.createElement('span'); status.className = 'activity-status'; status.textContent = statusGlyph(entry.status);
    const label = document.createElement('span'); label.className = 'activity-label'; label.textContent = entry.label || 'Agent activity';
    head.append(status, label); row.append(head);

    if (entry.diff) row.append(detailBlock('Show changes', entry.diff, 'diff'));
    if (entry.output && !entry.diff) row.append(detailBlock(entry.kind === 'validation' ? 'Show checks' : 'Show output', entry.output));
    if (entry.arguments) row.append(detailBlock('Show arguments', entry.arguments));
    if (entry.details && !entry.output && !entry.diff) row.append(detailBlock('Details', entry.details));
    return row;
  }

  function detailBlock(label, content, kind = '') {
    const details = document.createElement('details'); details.className = `activity-details ${kind}`;
    const summary = document.createElement('summary'); summary.textContent = label;
    const pre = document.createElement('pre'); pre.textContent = String(content ?? '').slice(0, 128 * 1024);
    details.append(summary, pre); return details;
  }

  function renderVisibleMarkdown() {
    rendering = true;
    try {
      for (const node of messages.querySelectorAll('.message.assistant .message-content')) {
        if (node.dataset.markdownRendered === '1') continue;
        renderMarkdownNode(node, node.textContent ?? '');
      }
    } finally { queueMicrotask(() => { rendering = false; }); }
  }

  function renderMessageById(messageId, source) {
    const selector = `[data-message-id="${cssEscape(messageId)}"] .message-content`;
    const node = messages.querySelector(selector);
    if (node) renderMarkdownNode(node, source);
  }

  function renderMarkdownNode(node, source) {
    rendering = true;
    node.innerHTML = renderMarkdown(source);
    node.dataset.markdownRendered = '1';
    node.classList.add('markdown-rendered');
    queueMicrotask(() => { rendering = false; });
  }

  function parseOutput(raw) {
    const text = String(raw ?? '');
    try {
      const value = JSON.parse(text);
      if (value && typeof value === 'object') {
        const diff = typeof value.diff === 'string' ? value.diff : typeof value.result?.diff === 'string' ? value.result.diff : '';
        return { diff, output: diff ? '' : JSON.stringify(value, null, 2) };
      }
    } catch {}
    const fenced = text.match(/```diff\s*\n([\s\S]*?)```/i);
    return { diff: fenced?.[1]?.trim() ?? '', output: fenced ? '' : text };
  }

  function prettyJson(raw) {
    const text = String(raw ?? '');
    if (!text || text === '{}') return '';
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
  }

  function startedLabel(tool) {
    return ({ tst_explore: 'Inspecting project structure', tst_read: 'Reading source', tst_edit_batch: 'Preparing code changes', tst_validate: 'Running validation', workspace_edit: 'Editing source', workspace_write: 'Writing source', bash: 'Running command', question: 'Waiting for your answer', cuppet_plan: 'Reading implementation plan', cuppet_memory_search: 'Searching memory' })[tool] || `Running ${tool || 'tool'}`;
  }

  function finishedLabel(event) {
    if (!event.success) return `${event.tool || 'Tool'} failed`;
    const paths = Array.isArray(event.paths) ? event.paths : [];
    if (event.tool === 'tst_edit_batch') return event.mutation ? `Updated ${paths.length || 1} file${paths.length === 1 ? '' : 's'}` : 'Prepared code changes';
    if (event.tool === 'tst_read') return `Read ${paths.length || 1} source target${paths.length === 1 ? '' : 's'}`;
    if (event.tool === 'tst_explore') return 'Project structure inspected';
    if (event.tool === 'tst_validate') return 'Validation finished';
    if (event.tool === 'bash') return 'Command finished';
    if (event.mutation) return `Updated ${paths.length || 1} file${paths.length === 1 ? '' : 's'}`;
    return `${event.tool || 'Tool'} finished`;
  }

  function historicalLabel(execution) {
    const success = execution.status === 'complete';
    return success ? `${execution.toolName || 'Tool'} completed` : `${execution.toolName || 'Tool'} ${execution.status || 'finished'}`;
  }

  function statusGlyph(status) { return status === 'running' ? '…' : status === 'error' ? '×' : status === 'queued' ? '↳' : status === 'stopped' ? '–' : '✓'; }
  function cssEscape(value) { return globalThis.CSS?.escape ? CSS.escape(value) : String(value).replace(/[^A-Za-z0-9_-]/g, '\\$&'); }
}
