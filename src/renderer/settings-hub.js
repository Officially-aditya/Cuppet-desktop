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

  const providerSelect = document.getElementById('provider-id');
  const providerBaseUrl = document.getElementById('provider-base-url');
  const providerModel = document.getElementById('provider-model');
  const providerBackgroundModel = document.getElementById('provider-background-model');
  const providerApiKey = document.getElementById('provider-api-key');
  const providerApiKeyLabel = document.getElementById('provider-api-key-label');
  const providerApiKeyField = providerApiKey?.closest('label');
  const providerPresetNote = document.getElementById('provider-preset-note');
  const settingsForm = document.getElementById('settings-form');
  const settingsNote = document.getElementById('settings-note');
  let providerState = null;
  let providerPresets = [];

  const codexStatus = document.getElementById('codex-auth-status');
  const codexNote = document.getElementById('codex-auth-note');
  const codexLogin = document.getElementById('codex-auth-login');
  const codexLogout = document.getElementById('codex-auth-logout');
  const platformCodex = createPlatformCodexAuth();
  let codexPoll = null;
  let lastCodexState = null;

  const sections = {
    account: ['Account', 'Cuppet identity and connected account services.'],
    platform: ['Platform', 'Choose the provider Cuppet uses on this computer.'],
    personalisation: ['Personalisation', 'Tune how Cuppet Desktop looks and feels locally.'],
    usage: ['Token usage', 'Review model usage when exact provider telemetry is available.'],
    devices: ['Connected devices', 'See devices paired through Cuppet Remote.'],
    privacy: ['Data & privacy', 'Understand what stays local and how desktop credentials are handled.'],
    about: ['About', 'Desktop runtime and product information.'],
  };

  for (const button of sectionButtons) button.addEventListener('click', () => activate(button.dataset.settingsSection));

  settingsButton?.addEventListener('click', () => requestAnimationFrame(() => {
    activate('account');
    void refreshCodexAuth();
  }));
  dialog.addEventListener('close', () => {
    activate('platform');
    stopCodexPolling();
  });

  openRemote?.addEventListener('click', () => {
    dialog.close();
    document.getElementById('remote-button')?.click();
  });

  const compact = document.getElementById('pref-compact-sidebar');
  const reduceMotion = document.getElementById('pref-reduce-motion');
  const preferenceKey = 'cuppet.desktop.personalisation';
  const saved = readPreferences();
  if (compact) compact.checked = saved.compactSidebar === true;
  if (reduceMotion) reduceMotion.checked = saved.reduceMotion === true;
  applyPreferences(saved);
  for (const input of [compact, reduceMotion].filter(Boolean)) input.addEventListener('change', savePreferences);

  providerSelect?.addEventListener('change', () => applySelectedProvider(providerSelect.value, true));
  settingsForm?.addEventListener('submit', guardProviderSubmit, true);
  codexLogin?.addEventListener('click', () => void startCodexLogin());
  codexLogout?.addEventListener('click', () => void logoutCodex());
  platformCodex.login?.addEventListener('click', () => void startCodexLogin());
  platformCodex.logout?.addEventListener('click', () => void logoutCodex());

  void refreshProviderForm();
  void refreshCodexAuth();

  function activate(section) {
    if (!sections[section]) section = 'platform';
    for (const button of sectionButtons) button.classList.toggle('active', button.dataset.settingsSection === section);
    for (const panel of panels) panel.classList.toggle('active', panel.dataset.settingsPanel === section);
    title.textContent = sections[section][0];
    description.textContent = sections[section][1];
    if (section === 'devices') void refreshDevices();
    if (section === 'usage') void refreshUsageProvider();
    if (section === 'platform') void refreshProviderForm();
    if (section === 'account') void refreshCodexAuth();
  }

  async function refreshProviderForm() {
    if (!providerSelect || !window.cuppet?.settings?.get) return;
    try {
      providerState = await window.cuppet.settings.get();
      providerPresets = Array.isArray(providerState?.presets) ? providerState.presets : [];
      const selected = providerState?.presetID || providerState?.providerID || providerPresets[0]?.id || '';
      const previous = providerSelect.value;
      providerSelect.replaceChildren();
      for (const preset of providerPresets) {
        const option = document.createElement('option');
        option.value = preset.id;
        option.textContent = preset.label;
        providerSelect.append(option);
      }
      providerSelect.value = providerPresets.some((preset) => preset.id === selected) ? selected : (previous || providerPresets[0]?.id || '');
      applySelectedProvider(providerSelect.value, false);
    } catch (error) {
      if (providerPresetNote) providerPresetNote.textContent = error?.message || 'Provider settings unavailable.';
    }
  }

  function applySelectedProvider(providerID, userChanged) {
    const preset = providerPresets.find((item) => item.id === providerID);
    if (!preset) return;
    if (providerBaseUrl) providerBaseUrl.value = preset.baseUrl || '';
    if (providerModel) providerModel.value = preset.model || '';
    if (providerBackgroundModel) providerBackgroundModel.value = preset.model || '';
    if (providerApiKeyLabel) providerApiKeyLabel.textContent = preset.authLabel || 'API key';
    if (providerPresetNote) providerPresetNote.textContent = preset.note || `${preset.label} endpoint and default coding model are configured automatically.`;

    const chatGPTProvider = preset.authType === 'chatgpt';
    providerApiKeyField?.classList.toggle('hidden', chatGPTProvider);
    platformCodex.root?.classList.toggle('hidden', !chatGPTProvider);
    if (providerApiKey) {
      if (userChanged) providerApiKey.value = '';
      if (chatGPTProvider) {
        providerApiKey.required = false;
        providerApiKey.placeholder = 'No API key required';
      } else {
        const sameSavedProvider = providerState && (providerState.presetID || providerState.providerID) === preset.id;
        const savedKey = Boolean(sameSavedProvider && providerState.apiKeyConfigured);
        providerApiKey.required = !savedKey || !sameSavedProvider;
        providerApiKey.placeholder = savedKey ? 'Leave blank to keep the saved key' : `Enter ${preset.authLabel || `${preset.label} API key`}`;
      }
    }
    if (chatGPTProvider) void refreshCodexAuth();
  }

  async function guardProviderSubmit(event) {
    const preset = providerPresets.find((item) => item.id === providerSelect?.value);
    if (preset?.authType !== 'chatgpt') return;
    event.preventDefault();
    let auth;
    try { auth = await window.cuppet?.codexAuth?.status?.(); }
    catch (error) {
      event.stopImmediatePropagation();
      if (settingsNote) settingsNote.textContent = error?.message || 'Codex authentication unavailable.';
      return;
    }
    if (auth?.loggedIn === true) {
      // app.js owns persistence; submit a fresh event after the async auth check.
      settingsForm?.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: event.submitter }));
      return;
    }
    event.stopImmediatePropagation();
    if (settingsNote) settingsNote.textContent = 'Continue with ChatGPT before saving Codex as the active provider.';
    activate('platform');
    await refreshCodexAuth();
  }

  async function startCodexLogin() {
    if (!window.cuppet?.codexAuth?.login) return;
    setCodexBusy(true);
    setCodexMessage('Opening the official ChatGPT sign-in through Codex…');
    try {
      await window.cuppet.codexAuth.login();
      startCodexPolling();
      await refreshCodexAuth();
    } catch (error) {
      setCodexMessage(error?.message || String(error));
      setCodexBusy(false);
    }
  }

  async function logoutCodex() {
    if (!window.cuppet?.codexAuth?.logout) return;
    setCodexBusy(true);
    try {
      await window.cuppet.codexAuth.logout();
      stopCodexPolling();
      await refreshCodexAuth();
    } catch (error) {
      setCodexMessage(error?.message || String(error));
      setCodexBusy(false);
    }
  }

  async function refreshCodexAuth() {
    if (!window.cuppet?.codexAuth?.status) return;
    try {
      const value = await window.cuppet.codexAuth.status();
      lastCodexState = value;
      const label = value.loggedIn ? 'Connected' : value.loginRunning ? 'Signing in…' : value.available ? 'Not connected' : 'Unavailable';
      for (const status of [codexStatus, platformCodex.status].filter(Boolean)) {
        status.textContent = label;
        status.classList.toggle('muted', !value.loggedIn);
      }
      setCodexMessage(value.message || (value.available ? 'Not connected to ChatGPT.' : 'Official Codex app-server not found.'));
      for (const login of [codexLogin, platformCodex.login].filter(Boolean)) {
        login.classList.toggle('hidden', value.loggedIn === true);
        login.disabled = value.available !== true || value.loginRunning === true;
      }
      for (const logout of [codexLogout, platformCodex.logout].filter(Boolean)) {
        logout.classList.toggle('hidden', value.loggedIn !== true);
        logout.disabled = value.loginRunning === true;
      }
      if (value.loginRunning) startCodexPolling();
      else if (value.loggedIn || !value.available) stopCodexPolling();
    } catch (error) {
      lastCodexState = null;
      for (const status of [codexStatus, platformCodex.status].filter(Boolean)) {
        status.textContent = 'Unavailable';
        status.classList.add('muted');
      }
      setCodexMessage(error?.message || 'Codex authentication unavailable.');
      setCodexBusy(false);
    }
  }

  function setCodexMessage(message) {
    if (codexNote) codexNote.textContent = message;
    if (platformCodex.note) platformCodex.note.textContent = message;
  }

  function setCodexBusy(value) {
    for (const button of [codexLogin, codexLogout, platformCodex.login, platformCodex.logout].filter(Boolean)) button.disabled = value;
  }

  function startCodexPolling() {
    if (codexPoll) return;
    codexPoll = window.setInterval(() => void refreshCodexAuth(), 1200);
  }

  function stopCodexPolling() {
    if (!codexPoll) return;
    clearInterval(codexPoll);
    codexPoll = null;
  }

  function createPlatformCodexAuth() {
    if (!providerPresetNote) return {};
    const root = document.createElement('div');
    root.className = 'settings-row codex-auth-row hidden';
    root.dataset.providerCodexAuth = 'true';
    const info = document.createElement('div');
    const heading = document.createElement('strong');
    heading.textContent = 'ChatGPT subscription';
    const note = document.createElement('span');
    note.textContent = 'Checking Codex authentication…';
    info.append(heading, note);
    const actions = document.createElement('div');
    actions.className = 'codex-auth-actions';
    const status = document.createElement('span');
    status.className = 'settings-status-pill muted';
    status.textContent = 'Checking…';
    const login = document.createElement('button');
    login.type = 'button'; login.className = 'primary-button'; login.textContent = 'Continue with ChatGPT';
    const logout = document.createElement('button');
    logout.type = 'button'; logout.className = 'ghost-button hidden'; logout.textContent = 'Sign out';
    actions.append(status, login, logout);
    root.append(info, actions);
    providerPresetNote.insertAdjacentElement('afterend', root);
    return { root, status, note, login, logout };
  }

  function readPreferences() {
    try { return JSON.parse(localStorage.getItem(preferenceKey) || '{}'); }
    catch { return {}; }
  }

  function savePreferences() {
    const value = {
      compactSidebar: compact?.checked === true,
      reduceMotion: reduceMotion?.checked === true,
    };
    localStorage.setItem(preferenceKey, JSON.stringify(value));
    applyPreferences(value);
  }

  function applyPreferences(value) {
    document.body.classList.toggle('compact-sidebar', value.compactSidebar === true);
    document.body.classList.toggle('reduce-motion', value.reduceMotion === true);
  }

  async function refreshUsageProvider() {
    if (!usageProvider || !window.cuppet?.settings?.get) return;
    try {
      const current = await window.cuppet.settings.get();
      const preset = current?.presets?.find?.((item) => item.id === (current?.presetID || current?.providerID));
      const provider = preset?.label || current?.providerID || 'Current provider';
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

  function cleanProjectRows() {
    projectList?.querySelectorAll('.remove-button').forEach((button) => button.remove());
  }
  cleanProjectRows();
  if (projectList) new MutationObserver(cleanProjectRows).observe(projectList, { childList: true, subtree: true });

  const menuObserver = new MutationObserver(() => {
    for (const button of document.querySelectorAll('.nav-context-menu button')) {
      if (button.textContent.trim().startsWith('Remove registration')) button.textContent = 'Remove project';
    }
  });
  menuObserver.observe(document.body, { childList: true, subtree: true });
})();
