(() => {
  if (!window.cuppet?.permissions) return;

  let current = null;
  const dialog = document.createElement('dialog');
  dialog.className = 'settings-dialog';
  dialog.setAttribute('aria-labelledby', 'permission-title');

  const header = document.createElement('div'); header.className = 'dialog-header';
  const headingWrap = document.createElement('div');
  const title = document.createElement('h2'); title.id = 'permission-title'; title.textContent = 'Tool permission';
  const subtitle = document.createElement('p'); subtitle.textContent = 'Cuppet is waiting for approval before the model can continue.';
  headingWrap.append(title, subtitle); header.append(headingWrap);

  const action = document.createElement('div'); action.className = 'dialog-note';
  const description = document.createElement('p');
  const resources = document.createElement('pre');
  resources.style.whiteSpace = 'pre-wrap'; resources.style.wordBreak = 'break-word'; resources.style.maxHeight = '240px'; resources.style.overflow = 'auto';

  const autoNote = document.createElement('p'); autoNote.className = 'settings-note';
  const actions = document.createElement('div'); actions.className = 'dialog-actions';
  const reject = button('Reject', 'ghost-button');
  const auto = button('Enable guarded auto', 'ghost-button');
  const exact = button('Always this exact request', 'ghost-button');
  const once = button('Allow once', 'primary-button');
  actions.append(reject, auto, exact, once);
  dialog.append(header, action, description, resources, autoNote, actions);
  document.body.append(dialog);

  function button(label, className) { const element = document.createElement('button'); element.type = 'button'; element.className = className; element.textContent = label; return element; }

  async function resolve(reply) {
    if (!current) return;
    const id = current.id;
    setBusy(true);
    try { await window.cuppet.permissions.reply(id, reply); }
    catch (error) { autoNote.textContent = error?.message || String(error); setBusy(false); return; }
    current = null;
    dialog.close();
    await showNext();
  }

  async function enableAuto() {
    if (!current?.autoEligible) return;
    setBusy(true);
    try {
      await window.cuppet.permissions.autoSet(current.sessionId, true);
      await window.cuppet.permissions.reply(current.id, 'once');
      current = null;
      dialog.close();
      await showNext();
    } catch (error) { autoNote.textContent = error?.message || String(error); setBusy(false); }
  }

  function setBusy(busy) { for (const element of [reject, auto, exact, once]) element.disabled = busy; }

  function show(request) {
    current = request;
    action.textContent = `${request.action || 'tool'} · session ${String(request.sessionId || '').slice(0, 24)}`;
    description.textContent = request.description || 'The model requested a protected tool operation.';
    resources.textContent = (request.resources || []).map((value) => `• ${value}`).join('\n') || 'No resource details were supplied.';
    auto.hidden = request.autoEligible !== true;
    autoNote.textContent = request.autoEligible === true
      ? 'Guarded auto only approves ordinary workspace reads/edits/writes. Sensitive files, shell commands, and path escapes still require approval.'
      : 'This request is not eligible for guarded auto approval.';
    setBusy(false);
    if (!dialog.open) dialog.showModal();
  }

  async function showNext() {
    const pending = await window.cuppet.permissions.list().catch(() => []);
    if (pending[0]) show(pending[0]);
  }

  reject.addEventListener('click', () => void resolve('reject'));
  exact.addEventListener('click', () => void resolve('always'));
  once.addEventListener('click', () => void resolve('once'));
  auto.addEventListener('click', () => void enableAuto());
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); void resolve('reject'); });

  const runtimeStatus = document.querySelector('#runtime-status');
  window.cuppet.onEvent((event) => {
    if (!event || typeof event.type !== 'string') return;
    if (event.type === 'permission.requested' && event.request) show(event.request);
    if (event.type === 'permission.resolved' && current?.id === event.requestId) { current = null; if (dialog.open) dialog.close(); void showNext(); }
    if (runtimeStatus && event.type === 'tool.started') runtimeStatus.textContent = `Running ${event.tool}…`;
    if (runtimeStatus && event.type === 'tool.finished') runtimeStatus.textContent = event.success ? `${event.tool} completed` : `${event.tool} blocked or failed`;
  });

  void showNext();
})();