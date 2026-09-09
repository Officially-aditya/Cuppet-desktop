(() => {
  const button = document.getElementById('undo-button');
  if (!button || !window.cuppet?.sessions?.undo) return;

  async function undoCurrent() {
    const session = typeof state !== 'undefined' ? state.active : null;
    if (!session) { toast('Open a project chat before using Undo.'); return; }
    if (!session.projectId) { toast('Undo is available only for project-bound chats.'); return; }
    if (state.runningSessions?.has(session.id)) { toast('Stop the current generation before using Undo.'); return; }
    button.disabled = true;
    try {
      const result = await window.cuppet.sessions.undo(session.id);
      toast(result?.undone ? `Undid ${result.path || 'the latest Cuppet mutation'}.` : (result?.reason || 'Nothing to undo.'));
      await refreshData();
      if (state.active?.id === session.id) await openSession(session.id);
    } catch (error) {
      toast(error?.message || String(error));
    } finally {
      update();
    }
  }

  function update() {
    const session = typeof state !== 'undefined' ? state.active : null;
    button.disabled = !session?.projectId || Boolean(state.runningSessions?.has(session.id));
  }

  button.addEventListener('click', () => void undoCurrent());
  document.addEventListener('click', () => queueMicrotask(update));
  window.cuppet.onEvent(() => update());
  update();
})();

void import('./execution-ui.mjs').catch((error) => console.error('Failed to load Cuppet execution UI', error));
