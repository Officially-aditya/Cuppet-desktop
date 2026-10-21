// Keep attention state in the main process so it also works when the renderer is hidden.
export function createApprovalAttention({ getWindow, setBadgeCount, notify }) {
  const pending = new Map();
  const notices = new Map();
  const dismiss = (id) => {
    notices.get(id)?.close();
    notices.delete(id);
  };
  const update = () => {
    setBadgeCount(pending.size);
    if (!pending.size) getWindow()?.flashFrame(false);
  };
  return {
    handle(event) {
      if (['permission.requested', 'question.requested'].includes(event?.type) && event.request?.id) {
        const { id, sessionId } = event.request;
        if (pending.has(id)) return;
        pending.set(id, sessionId);
        update();
        const win = getWindow();
        if (win?.isFocused()) return;
        win?.flashFrame(true);
        const notice = notify({
          title: event.type === 'permission.requested' ? 'Cuppet needs approval' : 'Cuppet needs your input',
          body: 'A chat is waiting for you to continue.',
          onClick: () => {
            const target = getWindow();
            if (!target) return;
            if (target.isMinimized()) target.restore();
            target.show();
            target.focus();
            if (sessionId) target.webContents.send('cuppet:attention:open-session', sessionId);
          },
        });
        if (notice) notices.set(id, notice);
      } else if (['permission.resolved', 'question.resolved'].includes(event?.type)) {
        pending.delete(event.requestId);
        dismiss(event.requestId);
        update();
      } else if (['run.finished', 'session.deleted'].includes(event?.type) && event.sessionId) {
        for (const [id, sessionId] of pending) {
          if (sessionId !== event.sessionId) continue;
          pending.delete(id);
          dismiss(id);
        }
        update();
      }
    },
    focused() {
      getWindow()?.flashFrame(false);
      for (const id of notices.keys()) dismiss(id);
    },
    dispose() {
      for (const id of notices.keys()) dismiss(id);
      pending.clear();
      update();
    },
  };
}
