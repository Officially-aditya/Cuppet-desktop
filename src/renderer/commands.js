(() => {
  const prompt = document.querySelector('#prompt');
  const composer = document.querySelector('#composer');
  const actions = composer?.querySelector('.composer-actions');
  if (!prompt || !composer || !actions || !window.cuppet?.commands) return;

  const palette = document.createElement('div');
  palette.className = 'command-palette hidden';
  palette.setAttribute('role', 'listbox');
  palette.setAttribute('aria-label', 'Cuppet commands');

  const result = document.createElement('div');
  result.className = 'command-result hidden';
  result.setAttribute('role', 'status');

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'command-trigger';
  trigger.textContent = '/';
  trigger.title = 'Commands';
  trigger.setAttribute('aria-label', 'Open commands');

  const dialog = document.createElement('dialog');
  dialog.className = 'command-dialog';
  dialog.setAttribute('aria-label', 'Command action');

  composer.parentElement?.insertBefore(result, composer);
  composer.parentElement?.insertBefore(palette, composer);
  document.body.append(dialog);
  actions.prepend(trigger);

  let commands = [];
  let visible = [];
  let selected = 0;
  let triggerOpen = false;

  window.cuppet.commands.list().then((items) => {
    commands = Array.isArray(items) ? items : [];
    updatePalette();
  }).catch((error) => showError(error));

  trigger.addEventListener('click', () => {
    triggerOpen = palette.classList.contains('hidden') || !triggerOpen;
    if (triggerOpen) {
      visible = commands.slice(0, 32);
      selected = 0;
      renderPalette();
      palette.classList.remove('hidden');
    } else hidePalette();
  });

  composer.addEventListener('submit', (event) => {
    const raw = prompt.value.trim();
    if (!raw.startsWith('/')) return;
    const item = slashDefinition(raw);
    if (!item) return;
    const sessionId = currentSessionId();
    if (item.requiresSession && !sessionId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    prompt.value = '';
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    hidePalette();
    void execute(item, raw, sessionId);
  }, true);

  prompt.addEventListener('input', () => {
    triggerOpen = false;
    updatePalette();
  });
  prompt.addEventListener('blur', () => setTimeout(() => { if (!dialog.open) hidePalette(); }, 120));
  prompt.addEventListener('keydown', (event) => {
    if (palette.classList.contains('hidden') || !visible.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault(); event.stopImmediatePropagation();
      selected = (selected + 1) % visible.length; renderPalette();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault(); event.stopImmediatePropagation();
      selected = (selected - 1 + visible.length) % visible.length; renderPalette();
    } else if (event.key === 'Escape') {
      event.preventDefault(); hidePalette();
    } else if (event.key === 'Enter' && !event.shiftKey) {
      const item = visible[selected];
      if (item?.slash && exactSlash(prompt.value, item)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      void choose(item);
    }
  }, true);

  window.cuppet.onEvent((event) => {
    if (event?.type !== 'command.completed') return;
    showResult(event);
  });

  function currentSessionId() {
    return String(document.body.dataset.cuppetSessionId || '').slice(0, 256);
  }

  function currentQuery() {
    const value = prompt.value;
    if (!value.startsWith('/') || value.includes('\n')) return null;
    return value.slice(1).split(/\s/, 1)[0].toLowerCase();
  }

  function slashDefinition(raw) {
    const name = raw.slice(1).split(/\s/, 1)[0].toLowerCase();
    return commands.find((item) => item?.slash === name || item?.aliases?.includes?.(name)) || null;
  }

  function exactSlash(value, item) {
    const trimmed = value.trim().toLowerCase();
    return trimmed === `/${item.slash}` || item.aliases?.some?.((alias) => trimmed === `/${alias}`);
  }

  function updatePalette() {
    const query = currentQuery();
    if (query === null || prompt.value.includes('\n') || /\s/.test(prompt.value.trim())) {
      hidePalette(); return;
    }
    const sessionId = currentSessionId();
    visible = commands.filter((item) => {
      if (item.requiresSession && !sessionId && item.paletteOnly) return false;
      const haystack = [item.slash, item.title, item.description, ...(item.aliases || [])].filter(Boolean).join(' ').toLowerCase();
      return !query || haystack.includes(query);
    }).slice(0, 16);
    selected = 0;
    if (!visible.length) { hidePalette(); return; }
    renderPalette();
    palette.classList.remove('hidden');
  }

  function renderPalette() {
    const sessionId = currentSessionId();
    palette.replaceChildren(...visible.map((item, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `command-option${index === selected ? ' selected' : ''}`;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', index === selected ? 'true' : 'false');
      button.disabled = Boolean(item.requiresSession && !sessionId && item.paletteOnly);
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => void choose(item));

      const name = document.createElement('div');
      name.className = 'command-name';
      name.textContent = item.slash ? `/${item.slash}` : item.title || item.id;
      const description = document.createElement('div');
      description.className = 'command-description';
      description.textContent = item.description || '';
      const meta = document.createElement('div');
      meta.className = 'command-meta';
      const aliases = item.aliases?.length ? `aliases: ${item.aliases.map((alias) => `/${alias}`).join(', ')}` : '';
      meta.textContent = [item.paletteOnly ? 'action' : item.requiresSession ? 'session' : 'global', aliases].filter(Boolean).join(' · ');
      button.append(name, description, meta);
      return button;
    }));
  }

  async function choose(item) {
    if (!item) return;
    if (item.paletteOnly) {
      hidePalette();
      await executePaletteAction(item);
      return;
    }
    if (!item.slash) return;
    prompt.value = `/${item.slash}${item.takesText ? ' ' : ''}`;
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    hidePalette();
    prompt.focus();
    const end = prompt.value.length;
    prompt.setSelectionRange(end, end);
  }

  async function execute(item, raw, sessionId) {
    try {
      const response = await window.cuppet.commands.execute(sessionId || null, raw);
      showResult(response);
    } catch (error) {
      showError(error);
    }
  }

  async function executePaletteAction(item) {
    const sessionId = currentSessionId();
    if (item.requiresSession && !sessionId) {
      showError(new Error('Start or open a chat before using this action.'));
      return;
    }
    try {
      let input = {};
      if (item.id === 'cuppet.memory.remember') input = await memoryRememberInput();
      else if (item.id === 'cuppet.memory.forget') input = await memoryForgetInput();
      else if (item.id === 'cuppet.memory.clear') input = await memoryClearInput();
      else if (item.id === 'cuppet.steer.interrupt') input = await steerInput();
      else if (item.id === 'cuppet.plan.agent') input = await modeInput(sessionId);
      if (input === null) return;
      const response = await window.cuppet.commands.execute(sessionId || null, { id: item.id, input });
      showResult(response);
    } catch (error) {
      showError(error);
    }
  }

  function memoryRememberInput() {
    return commandForm({
      title: 'Remember memory',
      submit: 'Remember',
      fields: [
        { name: 'key', label: 'Key', type: 'text', required: true, maxLength: 240 },
        { name: 'value', label: 'Value', type: 'textarea', required: true, maxLength: 4000 },
        { name: 'scope', label: 'Scope', type: 'select', value: 'project', options: ['session', 'project', 'global'] },
        { name: 'pinned', label: 'Pin this memory', type: 'checkbox' },
      ],
    });
  }

  function memoryForgetInput() {
    return commandForm({
      title: 'Forget memory',
      submit: 'Forget',
      destructive: true,
      fields: [{ name: 'key', label: 'Memory key', type: 'text', required: true, maxLength: 240 }],
    });
  }

  async function memoryClearInput() {
    const value = await commandForm({
      title: 'Clear memory scope',
      submit: 'Continue',
      fields: [{ name: 'scope', label: 'Scope', type: 'select', value: 'session', options: ['session', 'project', 'global'] }],
    });
    if (!value) return null;
    if (!window.confirm(`Clear ${value.scope} memory? This action cannot be undone from the command palette.`)) return null;
    return value;
  }

  function steerInput() {
    return commandForm({
      title: 'Interrupt and steer',
      submit: 'Interrupt & steer',
      fields: [{ name: 'text', label: 'Instruction', type: 'textarea', required: true, maxLength: 8192 }],
    });
  }

  async function modeInput(sessionId) {
    let current = 'build';
    try { current = (await window.cuppet.cognitive.modeGet(sessionId))?.mode || 'build'; } catch {}
    return commandForm({
      title: 'Plan / Build mode',
      submit: 'Set mode',
      fields: [{ name: 'mode', label: 'Mode', type: 'select', value: current, options: ['build', 'plan'] }],
    });
  }

  function commandForm({ title, submit, destructive = false, fields }) {
    dialog.replaceChildren();
    const form = document.createElement('form');
    form.method = 'dialog';
    form.className = 'command-dialog-form';
    const heading = document.createElement('h2'); heading.textContent = title;
    form.append(heading);
    const controls = new Map();

    for (const field of fields) {
      const label = document.createElement('label');
      label.textContent = field.label;
      let control;
      if (field.type === 'textarea') control = document.createElement('textarea');
      else if (field.type === 'select') {
        control = document.createElement('select');
        for (const option of field.options || []) {
          const node = document.createElement('option'); node.value = option; node.textContent = option;
          control.append(node);
        }
      } else {
        control = document.createElement('input'); control.type = field.type || 'text';
      }
      control.name = field.name;
      if (field.value != null && field.type !== 'checkbox') control.value = field.value;
      if (field.required) control.required = true;
      if (field.maxLength) control.maxLength = field.maxLength;
      label.append(control); form.append(label); controls.set(field.name, control);
    }

    const row = document.createElement('div'); row.className = 'command-dialog-actions';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'ghost-button'; cancel.textContent = 'Cancel';
    const accept = document.createElement('button'); accept.type = 'submit'; accept.className = destructive ? 'stop-button' : 'primary-button'; accept.textContent = submit;
    row.append(cancel, accept); form.append(row); dialog.append(form);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => { if (settled) return; settled = true; resolve(value); };
      cancel.addEventListener('click', () => { dialog.close(); finish(null); });
      dialog.addEventListener('cancel', () => finish(null), { once: true });
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (!form.reportValidity()) return;
        const value = {};
        for (const [name, control] of controls) value[name] = control.type === 'checkbox' ? control.checked : control.value.trim();
        dialog.close(); finish(value);
      });
      dialog.showModal();
      const first = controls.values().next().value;
      first?.focus?.();
    });
  }

  function hidePalette() {
    triggerOpen = false;
    palette.classList.add('hidden');
  }

  function showResult(event) {
    const presentation = typeof event?.presentation === 'string' && event.presentation ? event.presentation : summarize(event?.result);
    result.replaceChildren();
    const title = document.createElement('strong'); title.textContent = event?.slash || event?.id || 'Command';
    const text = document.createElement('span'); text.textContent = presentation;
    result.append(title, text); result.classList.remove('error', 'hidden');
    setTimeout(() => result.classList.add('hidden'), 8000);
  }

  function showError(error) {
    result.replaceChildren();
    const title = document.createElement('strong'); title.textContent = 'Command';
    const text = document.createElement('span'); text.textContent = error?.message || String(error);
    result.append(title, text); result.classList.add('error'); result.classList.remove('hidden');
    setTimeout(() => result.classList.add('hidden'), 10000);
  }

  function summarize(value) {
    if (value == null) return 'Completed.';
    if (typeof value === 'string') return value.slice(0, 600);
    if (Array.isArray(value)) return `${value.length} result${value.length === 1 ? '' : 's'}.`;
    if (typeof value === 'object') {
      if (typeof value.reason === 'string') return value.reason.slice(0, 600);
      if (typeof value.message === 'string') return value.message.slice(0, 600);
      if (typeof value.mode === 'string') return `Mode: ${value.mode}`;
      if (typeof value.enabled === 'boolean') return value.enabled ? 'Enabled.' : 'Disabled.';
      if (Array.isArray(value.models)) return `${value.models.length} coding model${value.models.length === 1 ? '' : 's'} configured.`;
      if (Array.isArray(value.catalog)) return `${value.catalog.length} provider group${value.catalog.length === 1 ? '' : 's'} available.`;
      return 'Completed.';
    }
    return String(value).slice(0, 600);
  }
})();
