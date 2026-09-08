const els = {
  sessionList: document.querySelector('#session-list'),
  newChat: document.querySelector('#new-chat'),
  title: document.querySelector('#conversation-title'),
  runtimeStatus: document.querySelector('#runtime-status'),
  providerPill: document.querySelector('#provider-pill'),
  messages: document.querySelector('#messages'),
  composer: document.querySelector('#composer'),
  prompt: document.querySelector('#prompt'),
  send: document.querySelector('#send-button'),
  stop: document.querySelector('#stop-button'),
  settingsButton: document.querySelector('#settings-button'),
  settingsDialog: document.querySelector('#settings-dialog'),
  settingsForm: document.querySelector('#settings-form'),
  settingsClose: document.querySelector('#settings-close'),
  settingsCancel: document.querySelector('#settings-cancel'),
  baseUrl: document.querySelector('#provider-base-url'),
  model: document.querySelector('#provider-model'),
  apiKey: document.querySelector('#provider-api-key'),
  settingsNote: document.querySelector('#settings-note'),
  toast: document.querySelector('#toast'),
};

const state = { sessions: [], active: null, runningSessionId: null, provider: null };

async function init() {
  window.cuppet.onEvent(handleRuntimeEvent);
  try {
    const [health, provider, sessions] = await Promise.all([
      window.cuppet.health(), window.cuppet.settings.get(), window.cuppet.sessions.list(),
    ]);
    state.provider = provider;
    state.sessions = sessions;
    els.runtimeStatus.textContent = health.ok ? 'Independent runtime ready · local SQLite' : 'Runtime unavailable';
    renderProvider();
    renderSessions();
    if (sessions[0]) await openSession(sessions[0].id);
  } catch (error) {
    els.runtimeStatus.textContent = 'Runtime unavailable';
    toast(error.message || String(error));
  }
}

async function createSession() {
  const session = await window.cuppet.sessions.create();
  upsertSession(session);
  await openSession(session.id);
  els.prompt.focus();
}

async function openSession(id) {
  const session = await window.cuppet.sessions.get(id);
  state.active = session;
  if (session.messages.some((message) => message.status === 'streaming')) state.runningSessionId = session.id;
  else if (state.runningSessionId === session.id) state.runningSessionId = null;
  renderSessions();
  renderConversation();
}

function renderSessions() {
  els.sessionList.replaceChildren(...state.sessions.map((session) => {
    const button = document.createElement('button');
    button.className = `session-item${state.active?.id === session.id ? ' active' : ''}`;
    button.type = 'button';
    button.addEventListener('click', () => void openSession(session.id));
    const title = document.createElement('div');
    title.className = 'session-title';
    title.textContent = session.title || 'New chat';
    const meta = document.createElement('div');
    meta.className = 'session-meta';
    meta.textContent = session.lastStatus === 'streaming' ? 'Generating…' : relativeTime(session.updatedAt);
    button.append(title, meta);
    return button;
  }));
}

function renderConversation() {
  els.title.textContent = state.active?.title || 'New chat';
  const messages = state.active?.messages ?? [];
  if (!messages.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = '<div class="empty-icon">⌁</div><h1>Start a conversation</h1><p>The first message is persisted before any provider request starts.</p>';
    els.messages.replaceChildren(empty);
  } else {
    els.messages.replaceChildren(...messages.filter((message) => message.role !== 'system').map(renderMessage));
    requestAnimationFrame(() => { els.messages.scrollTop = els.messages.scrollHeight; });
  }
  renderRunState();
}

function renderMessage(message) {
  const wrap = document.createElement('article');
  wrap.className = `message ${message.role}`;
  wrap.dataset.messageId = message.id;
  const role = document.createElement('div');
  role.className = 'message-role';
  role.textContent = message.role === 'assistant' ? 'Cuppet' : 'You';
  const content = document.createElement('div');
  content.className = 'message-content';
  content.textContent = message.content;
  wrap.append(role, content);
  if (message.status && message.status !== 'complete') {
    const status = document.createElement('div');
    status.className = `message-status${message.status === 'error' ? ' error' : ''}`;
    status.textContent = statusLabel(message.status);
    wrap.append(status);
  }
  return wrap;
}

async function sendCurrentMessage() {
  const text = els.prompt.value.trim();
  if (!text) return;
  if (!state.provider?.apiKeyConfigured || !state.provider?.model) {
    await openSettings();
    toast('Configure a provider and model before sending.');
    return;
  }
  if (!state.active) await createSession();
  if (!state.active) return;
  const sessionId = state.active.id;
  els.prompt.value = '';
  resizePrompt();
  try {
    await window.cuppet.sessions.send(sessionId, text);
    state.runningSessionId = sessionId;
    renderRunState();
  } catch (error) {
    toast(error.message || String(error));
  }
}

async function stopCurrent() {
  if (!state.runningSessionId) return;
  try { await window.cuppet.sessions.stop(state.runningSessionId); }
  catch (error) { toast(error.message || String(error)); }
}

function handleRuntimeEvent(event) {
  if (!event || typeof event.type !== 'string') return;
  if (event.type === 'run.started') state.runningSessionId = event.sessionId;
  if (event.type === 'run.finished' && state.runningSessionId === event.sessionId) state.runningSessionId = null;
  if (event.type === 'runtime.error') toast(event.message || 'Runtime error');
  if (event.session) upsertSession(event.session);
  if (event.message && state.active?.id === event.message.sessionId) upsertActiveMessage(event.message);
  if (event.type === 'message.delta' && state.active?.id === event.sessionId) {
    const message = state.active.messages.find((item) => item.id === event.messageId);
    if (message) {
      message.content = event.content;
      message.status = 'streaming';
      const node = els.messages.querySelector(`[data-message-id="${cssEscape(event.messageId)}"] .message-content`);
      if (node) node.textContent = event.content;
      els.messages.scrollTop = els.messages.scrollHeight;
    }
  }
  renderSessions();
  renderRunState();
  if (event.type === 'message.created' || event.type === 'message.completed') renderConversation();
}

function upsertSession(session) {
  const index = state.sessions.findIndex((item) => item.id === session.id);
  if (index >= 0) state.sessions[index] = { ...state.sessions[index], ...session };
  else state.sessions.unshift(session);
  state.sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  if (state.active?.id === session.id) state.active = { ...state.active, ...session };
}

function upsertActiveMessage(message) {
  const index = state.active.messages.findIndex((item) => item.id === message.id);
  if (index >= 0) state.active.messages[index] = message;
  else state.active.messages.push(message);
  state.active.messages.sort((a, b) => a.sequence - b.sequence);
}

function renderRunState() {
  const runningHere = Boolean(state.active?.id && state.runningSessionId === state.active.id);
  els.stop.classList.toggle('hidden', !runningHere);
  els.send.disabled = runningHere;
  els.prompt.disabled = runningHere;
}

async function openSettings() {
  state.provider = await window.cuppet.settings.get();
  els.baseUrl.value = state.provider.baseUrl || 'https://api.openai.com/v1';
  els.model.value = state.provider.model || '';
  els.apiKey.value = '';
  els.apiKey.placeholder = state.provider.apiKeyConfigured ? 'Saved securely · leave blank to keep it' : 'API key';
  els.settingsNote.textContent = state.provider.encryptionAvailable
    ? 'API keys are encrypted with the operating system credential store before persistence.'
    : 'OS credential encryption is unavailable. Cuppet will refuse to persist an API key in plaintext.';
  els.settingsDialog.showModal();
}

async function saveSettings(event) {
  event.preventDefault();
  try {
    state.provider = await window.cuppet.settings.save({ baseUrl: els.baseUrl.value, model: els.model.value, apiKey: els.apiKey.value });
    renderProvider();
    els.settingsDialog.close();
    toast('Provider settings saved.');
  } catch (error) {
    els.settingsNote.textContent = error.message || String(error);
  }
}

function renderProvider() {
  els.providerPill.textContent = state.provider?.apiKeyConfigured && state.provider?.model ? state.provider.model : 'Provider not configured';
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => els.toast.classList.add('hidden'), 4500);
}

function resizePrompt() {
  els.prompt.style.height = 'auto';
  els.prompt.style.height = `${Math.min(180, Math.max(54, els.prompt.scrollHeight))}px`;
}

function relativeTime(timestamp) {
  if (!timestamp) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

function statusLabel(status) {
  if (status === 'streaming') return 'Generating…';
  if (status === 'stopped') return 'Stopped';
  if (status === 'interrupted') return 'Interrupted by restart';
  if (status === 'error') return 'Generation failed';
  return status;
}

function cssEscape(value) {
  return window.CSS?.escape ? window.CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

els.newChat.addEventListener('click', () => void createSession());
els.composer.addEventListener('submit', (event) => { event.preventDefault(); void sendCurrentMessage(); });
els.prompt.addEventListener('input', resizePrompt);
els.prompt.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void sendCurrentMessage();
  }
});
els.stop.addEventListener('click', () => void stopCurrent());
els.settingsButton.addEventListener('click', () => void openSettings());
els.settingsForm.addEventListener('submit', saveSettings);
els.settingsClose.addEventListener('click', () => els.settingsDialog.close());
els.settingsCancel.addEventListener('click', () => els.settingsDialog.close());

void init();
