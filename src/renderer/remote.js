(() => {
  const button = document.getElementById('remote-button');
  const dialog = document.getElementById('remote-dialog');
  const close = document.getElementById('remote-close');
  const status = document.getElementById('remote-status');
  const note = document.getElementById('remote-note');
  const start = document.getElementById('remote-start');
  const stop = document.getElementById('remote-stop');
  const pair = document.getElementById('remote-invite-trusted');
  const invite = document.getElementById('remote-invite');
  const devices = document.getElementById('remote-devices');
  const devicesWrap = document.getElementById('remote-devices-wrap');
  if (!button || !dialog || !window.cuppet?.remote) return;

  button.addEventListener('click', async () => { dialog.showModal(); await refresh(); });
  close?.addEventListener('click', () => dialog.close());

  start?.addEventListener('click', () => run(async () => {
    note.textContent = 'Open Cuppet on your phone to link this computer…';
    const result = await window.cuppet.remote.start({ setup: true, createInvite: true });
    renderInvite(result?.invite);
  }, { preserveNote: true }));

  stop?.addEventListener('click', () => run(async () => {
    await window.cuppet.remote.stop();
    note.textContent = '';
    hideInvite();
  }));

  pair?.addEventListener('click', () => run(async () => {
    renderInvite(await window.cuppet.remote.invite('trusted'));
  }, { preserveNote: true }));

  window.cuppet.onEvent((event) => {
    if (event?.type === 'remote.setup') {
      const setupValue = event.setup ?? {};
      const code = setupValue.code ? `Code ${setupValue.code}` : 'Setup ready';
      note.textContent = setupValue.url ? `${code} · ${setupValue.url}` : code;
    }
    if (event?.type === 'remote.invite') renderInvite(event.invite);
    if (['remote.started', 'remote.stopped'].includes(event?.type)) void refresh();
  });

  async function run(action, { preserveNote = false } = {}) {
    setBusy(true);
    try {
      await action();
      if (!preserveNote) note.textContent = '';
      await refresh();
    } catch (error) {
      note.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    try {
      const [current, paired] = await Promise.all([window.cuppet.remote.status(), window.cuppet.remote.devices()]);
      const running = Boolean(current.running);
      status.textContent = running ? (current.connected ? 'Connected' : 'Connecting…') : 'Off';
      start?.classList.toggle('hidden', running);
      stop?.classList.toggle('hidden', !running);
      pair?.classList.toggle('hidden', !running);
      devicesWrap?.classList.toggle('hidden', !running && !(paired ?? []).length);
      if (running && current.connected && note.textContent.startsWith('Open Cuppet')) note.textContent = '';
      renderDevices(paired ?? []);
    } catch (error) {
      status.textContent = 'Unavailable';
      note.textContent = error instanceof Error ? error.message : String(error);
    }
  }

  function renderInvite(value) {
    if (!value?.code) return hideInvite();
    const expires = Number.isFinite(value.expiresAt) ? new Date(value.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'soon';
    invite.textContent = `Pairing code ${value.code} · expires ${expires}`;
    invite.classList.remove('hidden');
  }

  function hideInvite() {
    if (!invite) return;
    invite.textContent = '';
    invite.classList.add('hidden');
  }

  function renderDevices(values) {
    if (!devices) return;
    devices.replaceChildren();
    if (!values.length) {
      devices.textContent = 'No paired devices yet.';
      return;
    }
    for (const device of values) {
      const row = document.createElement('div'); row.className = 'repo-result';
      const name = document.createElement('strong'); name.textContent = device.name || 'Cuppet device';
      const revoke = document.createElement('button'); revoke.type = 'button'; revoke.className = 'text-button'; revoke.textContent = 'Revoke';
      revoke.addEventListener('click', () => run(async () => { await window.cuppet.remote.revoke(device.deviceId); }));
      row.append(name, revoke); devices.append(row);
    }
  }

  function setBusy(value) {
    for (const element of [start, stop, pair]) if (element) element.disabled = value;
  }
})();
