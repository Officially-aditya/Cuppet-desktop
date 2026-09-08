window.cuppet.onEvent((event) => {
  if (!event || event.type !== 'pe3.routed' || !event.targetSessionId || event.targetSessionId === event.sourceSessionId) return;
  const action = event.action === 'reactivate' ? 'Resumed earlier task context' : 'Started a separate task context';
  if (typeof window.toast === 'function') window.toast(`${action}.`);
  if (typeof window.openSession === 'function') void window.openSession(event.targetSessionId);
});
