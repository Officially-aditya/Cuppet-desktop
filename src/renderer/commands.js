(() => {
  const prompt = document.querySelector('#prompt');
  const composer = document.querySelector('#composer');
  if (!prompt || !composer || !window.cuppet?.commands) return;

  const palette = document.createElement('div');
  palette.className = 'command-palette hidden';
  palette.setAttribute('role', 'listbox');
  palette.setAttribute('aria-label', 'Cuppet commands');

  const result = document.createElement('div');
  result.className = 'command-result hidden';
  result.setAttribute('role', 'status');

  composer.parentElement?.insertBefore(result, composer);
  composer.parentElement?.insertBefore(palette, composer);

  let commands = [];
  let visible = [];
  let selected = 0;

  window.cuppet.commands.list().then((items) => {
    commands = Array.isArray(items) ? items.filter((item) => item?.slash && !item.paletteOnly) : [];
    updatePalette();
  }).catch(() => {});

  prompt.addEventListener('input', updatePalette);
  prompt.addEventListener('blur', () => setTimeout(hidePalette, 120));
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
    } else if (event.key === 'Enter' && !event.shiftKey && currentQuery().length) {
      event.preventDefault(); event.stopImmediatePropagation(); choose(visible[selected]);
    }
  }, true);

  window.cuppet.onEvent((event) => {
    if (event?.type !== 'command.completed') return;
    showResult(event);
  });

  function currentQuery() {
    const value = prompt.value;
    if (!value.startsWith('/') || value.includes('\n')) return '';
    return value.slice(1).split(/\s/, 1)[0].toLowerCase();
  }

  function updatePalette() {
    const query = currentQuery();
    if (!prompt.value.startsWith('/') || prompt.value.includes('\n') || /\s/.test(prompt.value.trim())) {
      hidePalette(); return;
    }
    visible = commands.filter((item) => {
      if (!query) return true;
      return item.slash.startsWith(query) || item.aliases?.some?.((alias) => alias.startsWith(query)) || item.description?.toLowerCase?.().includes(query);
    }).slice(0, 12);
    selected = 0;
    if (!visible.length) { hidePalette(); return; }
    renderPalette(); palette.classList.remove('hidden');
  }

  function renderPalette() {
    palette.replaceChildren(...visible.map((item, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `command-option${index === selected ? ' selected' : ''}`;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', index === selected ? 'true' : 'false');
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => choose(item));
      const name = document.createElement('div'); name.className = 'command-name'; name.textContent = `/${item.slash}`;
      const description = document.createElement('div'); description.className = 'command-description'; description.textContent = item.description || '';
      const meta = document.createElement('div'); meta.className = 'command-meta';
      const aliases = item.aliases?.length ? `aliases: ${item.aliases.map((alias) => `/${alias}`).join(', ')}` : '';
      meta.textContent = [item.requiresSession ? 'session' : 'global', aliases].filter(Boolean).join(' · ');
      button.append(name, description, meta); return button;
    }));
  }

  function choose(item) {
    if (!item?.slash) return;
    prompt.value = `/${item.slash}${item.takesText ? ' ' : ''}`;
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    hidePalette(); prompt.focus();
    const end = prompt.value.length; prompt.setSelectionRange(end, end);
  }

  function hidePalette() { palette.classList.add('hidden'); }

  function showResult(event) {
    const presentation = typeof event.presentation === 'string' && event.presentation ? event.presentation : summarize(event.result);
    result.replaceChildren();
    const title = document.createElement('strong'); title.textContent = event.slash || event.id || 'Command';
    const text = document.createElement('span'); text.textContent = presentation;
    result.append(title, text); result.classList.remove('hidden');
    setTimeout(() => result.classList.add('hidden'), 8000);
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
