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
  const queueButton = modeButton('Queue', 'Run this message after the active turn.', 'queue');
  const steerButton = modeButton('Steer', 'Interrupt the active turn and apply this instruction immediately.', 'steer');
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
    else void queueTurn(sessionId, text);
  }, true);

  window.cuppet.onEvent((event) => {
    if (!event || typeof event.type !== 'string') return;
    const sessionId = String(event.sessionId ?? event.message?.sessionId ?? '');

    if (event.type === 'run.started' && sessionId) running.add(sessionId);
    if (event.type === 'run.finished' && sessionId) running.delete(sessionId);
    if (event.type === 'queue.queued' && sessionId) addActivity(sessionId, { id: event.queueId, kind: 'queue', status: 'queued', label: `Queued message${event.position ? ` #${event.position}` : ''}` });
    if (event.type === 'queue.started' && sessionId) updateActivity(sessionId, event.queueId, { kind: 'queue', status: 'running', label: 'Starting queued message' });
    if (event.type === 'queue.dispatched' && sessionId) updateActivity(sessionId, event.queueId, { kind: 'queue', status: 'complete', label: event.runSessionId && event.runSessionId !== sessionId ? 'Queued message routed to task' : 'Queued message started' });
    if (event.type === 'queue.failed' && sessionId) updateActivity(sessionId, event.queueId, { kind: 'queue', status: 'error', label: 'Queued message failed', details: event.message || '' });
    if (event.type === 'tool.started' && sessionId) addActivity(sessionId, { id: event.executionId, kind: 'tool', tool: event.tool, status: 'running', label: startedLabel(event.tool) });
    if (event.type === 'tool.finished' && sessionId) void finishTool(sessionId, event);
    if (event.type === 'validation.completed' && sessionId) addValidation(sessionId, event.validation);
    if (event.type === 'graph.refresh.failed' && sessionId) addActivity(sessionId, { id: `graph-${Date.now()}`, kind: 'validation', status: 'error', label: 'TST graph refresh failed', details: event.message || '' });
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

  const messageObserver = new MutationObserver(() => { if (!rendering) renderVisibleMarkdown(); });
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

  async function queueTurn(sessionId, text) {
    try {
      const result = await window.cuppet.sessions.send(sessionId, text);
      if (!result?.queued && result?.sessionId) running.add(result.sessionId);
    } catch (error) {
      addActivity(sessionId, { id: `queue-error-${Date.now()}`, kind: 'queue', status: 'error', label: 'Could not queue message', details: error?.message || String(error) });
      renderActivity();
    }
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
    updateActivity(sessionId, event.executionId, { id: event.executionId, kind: 'tool', tool: event.tool, status: event.success ? 'complete' : 'error', label: finishedLabel(event), ...(event.message ? { details: event.message } : {}) });
    try {
      const session = await window.cuppet.sessions.get(sessionId);
      const execution = session?.toolExecutions?.find?.((item) => item.id === event.executionId);
      if (execution) {
        const parsed = parseOutput(execution.output);
        updateActivity(sessionId, event.executionId, { arguments: prettyJson(execution.argumentsJson), output: parsed.output, diff: parsed.diff, ...(!event.success ? { details: execution.output } : {}) });
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
  }

  function addActivity(sessionId, entry) {
    const list = activity.get(sessionId) ?? [];
    const index = list.findIndex((item) => item.id === entry.id);
    if (index >= 0) list[index] = { ...list[index], ...entry };
    else list.push(entry);
    activity.set(sessionId, list.slice(-30));
  }

  function updateActivity(sessionId, id, patch) {
    const list = activity.get(sessionId) ?? [];
    const index = list.findIndex((item) => item.id === id);
    if (index >= 0) list[index] = { ...list[index], ...patch };
    else list.push({ id, ...patch });
    activity.set(sessionId, list.slice(-30));
  }

  async function loadActivityForCurrent() {
    const sessionId = currentSessionId();
    if (!sessionId || activity.has(sessionId)) return;
    try {
      const session = await window.cuppet.sessions.get(sessionId);
      const entries = (session?.toolExecutions ?? []).slice(-20).map((execution) => {
        const parsed = parseOutput(execution.output);
        return { id: execution.id, kind: 'tool', tool: execution.toolName, status: execution.status === 'complete' ? 'complete' : execution.status === 'running' ? 'running' : 'error', label: `${execution.toolName || 'Tool'} ${execution.status === 'complete' ? 'completed' : execution.status}`, arguments: prettyJson(execution.argumentsJson), output: parsed.output, diff: parsed.diff };
      });
      if (entries.length) activity.set(sessionId, entries);
    } catch {}
    renderActivity();
  }

  function renderActivity() {
    const list = activity.get(currentSessionId()) ?? [];
    if (!list.length) { panel.classList.add('hidden'); panel.replaceChildren(); return; }
    panel.replaceChildren(...list.slice(-12).map(activityNode));
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
    if (entry.output) row.append(detailBlock(entry.kind === 'validation' ? 'Show checks' : entry.diff ? 'Show result' : 'Show output', entry.output));
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
        if (node.dataset.markdownRendered !== '1') renderMarkdownNode(node, node.textContent ?? '');
      }
    } finally { queueMicrotask(() => { rendering = false; }); }
  }

  function renderMessageById(messageId, source) {
    const node = messages.querySelector(`[data-message-id="${cssEscape(messageId)}"] .message-content`);
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
    if (fenced) return { diff: fenced[1].trim(), output: '' };
    if (/^TST EDIT BATCH (?:PREPARED|APPLIED)/.test(text)) {
      const split = text.indexOf('\n\n');
      if (split >= 0) return { diff: text.slice(split + 2).trim(), output: text.slice(0, split).trim() };
    }
    return { diff: '', output: text };
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

  function statusGlyph(status) { return status === 'running' ? '…' : status === 'error' ? '×' : status === 'queued' ? '↳' : '✓'; }
  function cssEscape(value) { return globalThis.CSS?.escape ? CSS.escape(value) : String(value).replace(/[^A-Za-z0-9_-]/g, '\\$&'); }
}
