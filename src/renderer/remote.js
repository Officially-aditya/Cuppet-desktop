(() => {
  const button = document.getElementById('remote-button');
  const dialog = document.getElementById('remote-dialog');
  const close = document.getElementById('remote-close');
  const status = document.getElementById('remote-status');
  const note = document.getElementById('remote-note');
  const relay = document.getElementById('remote-relay-url');
  const apiBase = document.getElementById('remote-api-base');
  const start = document.getElementById('remote-start');
  const setup = document.getElementById('remote-setup');
  const stop = document.getElementById('remote-stop');
  const trusted = document.getElementById('remote-invite-trusted');
  const viewer = document.getElementById('remote-invite-viewer');
  const invite = document.getElementById('remote-invite');
  const devices = document.getElementById('remote-devices');
  if (!button || !dialog || !window.cuppet?.remote) return;

  button.addEventListener('click', async () => { dialog.showModal(); await refresh(); });
  close?.addEventListener('click', () => dialog.close());
  start?.addEventListener('click', () => run(async () => {
    const relayUrl = relay?.value.trim() ?? '';
    if (!relayUrl) throw new Error('Enter a relay URL first.');
    const result = await window.cuppet.remote.start({ relayUrl, createInvite: true });
    renderInvite(result?.invite);
  }));
  setup?.addEventListener('click', () => run(async () => {
    const value = apiBase?.value.trim() ?? '';
    if (!value) throw new Error('Enter the Cuppet API base used by your signed-in app.');
    note.textContent = 'Creating a one-time app-link setup…';
    const result = await window.cuppet.remote.start({ apiBase: value, setup: true, createInvite: true });
    renderInvite(result?.invite);
  }));
  stop?.addEventListener('click', () => run(async () => { await window.cuppet.remote.stop(); invite.textContent = 'Remote control is stopped.'; }));
  trusted?.addEventListener('click', () => run(async () => renderInvite(await window.cuppet.remote.invite('trusted'))));
  viewer?.addEventListener('click', () => run(async () => renderInvite(await window.cuppet.remote.invite('viewer'))));

  window.cuppet.onEvent((event) => {
    if (event?.type === 'remote.setup') {
      const setupValue = event.setup ?? {};
      note.textContent = `Open or scan this one-time Cuppet setup: ${setupValue.url ?? setupValue.code ?? ''}`;
    }
    if (event?.type === 'remote.invite') renderInvite(event.invite);
    if (['remote.started', 'remote.stopped'].includes(event?.type)) void refresh();
  });

  async function run(action) {
    setBusy(true);
    try { await action(); note.textContent = ''; await refresh(); }
    catch (error) { note.textContent = error instanceof Error ? error.message : String(error); }
    finally { setBusy(false); }
  }
  async function refresh() {
    try {
      const [current, paired] = await Promise.all([window.cuppet.remote.status(), window.cuppet.remote.devices()]);
      status.textContent = current.running
        ? `${current.connected ? 'Connected' : 'Connecting'} · ${current.name} · ${current.hostId}${current.relayUrl ? ` · ${current.relayUrl}` : ''}`
        : `Off · ${current.name} · ${current.hostId}`;
      if (relay && current.relayUrl && !relay.value) relay.value = current.relayUrl;
      renderDevices(paired ?? []);
      stop.disabled = !current.running;
      trusted.disabled = !current.running;
      viewer.disabled = !current.running;
    } catch (error) { status.textContent = `Remote unavailable: ${error instanceof Error ? error.message : String(error)}`; }
  }
  function renderInvite(value) {
    if (!value?.code) return;
    const expires = Number.isFinite(value.expiresAt) ? new Date(value.expiresAt).toLocaleTimeString() : 'soon';
    invite.textContent = `Code ${value.code} · ${value.role ?? 'trusted'} · expires ${expires}${value.url ? ` · ${value.url}` : ''}`;
  }
  function renderDevices(values) {
    devices.replaceChildren();
    if (!values.length) { devices.textContent = 'No paired devices.'; return; }
    for (const device of values) {
      const row = document.createElement('div'); row.className = 'repo-result';
      const info = document.createElement('div');
      const name = document.createElement('strong'); name.textContent = device.name || device.deviceId;
      const meta = document.createElement('div'); meta.className = 'muted-inline'; meta.textContent = `${device.deviceId} · ${(device.scopes ?? []).join(', ')}`;
      info.append(name, meta);
      const revoke = document.createElement('button'); revoke.type = 'button'; revoke.className = 'text-button'; revoke.textContent = 'Revoke';
      revoke.addEventListener('click', () => run(async () => { await window.cuppet.remote.revoke(device.deviceId); }));
      row.append(info, revoke); devices.append(row);
    }
  }
  function setBusy(value) { for (const element of [start, setup, stop, trusted, viewer]) if (element) element.disabled = value; }
})();
