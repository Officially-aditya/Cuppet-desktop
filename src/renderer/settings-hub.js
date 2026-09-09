(() => {
  const dialog = document.getElementById('settings-dialog');
  if (!dialog) return;

  const title = document.getElementById('settings-section-title');
  const description = document.getElementById('settings-section-description');
  const settingsButton = document.getElementById('settings-button');
  const sectionButtons = [...dialog.querySelectorAll('[data-settings-section]')];
  const panels = [...dialog.querySelectorAll('[data-settings-panel]')];
  const deviceList = document.getElementById('settings-devices');
  const openRemote = document.getElementById('settings-open-remote');
  const usageProvider = document.getElementById('usage-provider');
  const projectList = document.getElementById('project-list');

  const sections = {
    account: ['Account', 'Cuppet identity and desktop account state.'],
    platform: ['Platform', 'Choose the models Cuppet uses on this computer.'],
    personalisation: ['Personalisation', 'Tune how Cuppet Desktop looks and feels locally.'],
    usage: ['Token usage', 'Review model usage when exact provider telemetry is available.'],
    devices: ['Connected devices', 'See devices paired through Cuppet Remote.'],
    privacy: ['Data & privacy', 'Understand what stays local and how desktop credentials are handled.'],
    about: ['About', 'Desktop runtime and product information.'],
  };

  for (const button of sectionButtons) {
    button.addEventListener('click', () => activate(button.dataset.settingsSection));
  }

  // Manual Settings opens to the broader account overview. Provider-required flows still
  // land on Platform because that is the markup default before this click handler runs.
  settingsButton?.addEventListener('click', () => requestAnimationFrame(() => activate('account')));

  openRemote?.addEventListener('click', () => {
    dialog.close();
    document.getElementById('remote-button')?.click();
  });

  const compact = document.getElementById('pref-compact-sidebar');
  const reduceMotion = document.getElementById('pref-reduce-motion');
  const hideHints = document.getElementById('pref-hide-hints');
  const preferenceKey = 'cuppet.desktop.personalisation';
  const saved = readPreferences();
  compact.checked = saved.compactSidebar === true;
  reduceMotion.checked = saved.reduceMotion === true;
  hideHints.checked = saved.hideComposerHints === true;
  applyPreferences(saved);

  for (const input of [compact, reduceMotion, hideHints]) input?.addEventListener('change', savePreferences);

  function activate(section) {
    if (!sections[section]) section = 'platform';
    for (const button of sectionButtons) button.classList.toggle('active', button.dataset.settingsSection === section);
    for (const panel of panels) panel.classList.toggle('active', panel.dataset.settingsPanel === section);
    title.textContent = sections[section][0];
    description.textContent = sections[section][1];
    if (section === 'devices') void refreshDevices();
    if (section === 'usage') void refreshUsageProvider();
  }

  function readPreferences() {
    try { return JSON.parse(localStorage.getItem(preferenceKey) || '{}'); }
    catch { return {}; }
  }

  function savePreferences() {
    const value = {
      compactSidebar: compact?.checked === true,
      reduceMotion: reduceMotion?.checked === true,
      hideComposerHints: hideHints?.checked === true,
    };
    localStorage.setItem(preferenceKey, JSON.stringify(value));
    applyPreferences(value);
  }

  function applyPreferences(value) {
    document.body.classList.toggle('compact-sidebar', value.compactSidebar === true);
    document.body.classList.toggle('reduce-motion', value.reduceMotion === true);
    document.body.classList.toggle('hide-composer-hints', value.hideComposerHints === true);
  }

  async function refreshUsageProvider() {
    if (!usageProvider || !window.cuppet?.settings?.get) return;
    try {
      const current = await window.cuppet.settings.get();
      const provider = current?.providerID || current?.providerId || current?.id || 'Current provider';
      const model = current?.primary?.modelID || current?.model || '';
      usageProvider.textContent = model ? `${provider} · ${model}` : provider;
    } catch { usageProvider.textContent = 'Current provider'; }
  }

  async function refreshDevices() {
    if (!deviceList) return;
    deviceList.innerHTML = '<div class="settings-empty">Loading devices…</div>';
    try {
      const values = await window.cuppet?.remote?.devices?.();
      if (!Array.isArray(values) || !values.length) {
        deviceList.innerHTML = '<div class="settings-empty">No paired devices.</div>';
        return;
      }
      deviceList.replaceChildren(...values.map((device) => {
        const row = document.createElement('div');
        row.className = 'settings-device';
        const info = document.createElement('div');
        const name = document.createElement('strong');
        name.textContent = device.name || 'Cuppet device';
        const meta = document.createElement('span');
        meta.textContent = device.lastSeenAt ? `Last seen ${new Date(device.lastSeenAt).toLocaleString()}` : 'Paired with Remote';
        info.append(name, meta);
        const state = document.createElement('span');
        state.textContent = 'Connected';
        row.append(info, state);
        return row;
      }));
    } catch (error) {
      deviceList.innerHTML = `<div class="settings-empty">${escapeText(error?.message || 'Connected devices unavailable.')}</div>`;
    }
  }

  function escapeText(value) {
    const div = document.createElement('div');
    div.textContent = value;
    return div.innerHTML;
  }

  // Remove the old inline project removal affordance entirely. Project deletion remains in
  // the project hamburger menu, where D1 already owns lifecycle actions.
  function cleanProjectRows() {
    projectList?.querySelectorAll('.remove-button').forEach((button) => button.remove());
  }
  cleanProjectRows();
  if (projectList) new MutationObserver(cleanProjectRows).observe(projectList, { childList: true, subtree: true });

  // D1 renders its context menu dynamically. Keep its behavior and confirmation semantics,
  // but use the product-facing label requested for the project action.
  const menuObserver = new MutationObserver(() => {
    for (const button of document.querySelectorAll('.nav-context-menu button')) {
      if (button.textContent.trim().startsWith('Remove registration')) button.textContent = 'Remove project';
    }
  });
  menuObserver.observe(document.body, { childList: true, subtree: true });
})();
