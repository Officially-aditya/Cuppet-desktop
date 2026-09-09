(() => {
  const handle = document.getElementById('sidebar-resizer');
  if (!handle) return;

  const root = document.documentElement;
  const storageKey = 'cuppet.sidebarWidth';
  const min = 220;
  const max = 420;
  const defaultWidth = 270;
  let dragging = false;

  const clamp = (value) => Math.min(max, Math.max(min, Math.round(Number(value) || defaultWidth)));
  const currentWidth = () => {
    const value = Number.parseInt(getComputedStyle(root).getPropertyValue('--sidebar-width'), 10);
    return Number.isFinite(value) ? value : defaultWidth;
  };
  const apply = (value, persist = true) => {
    const width = clamp(value);
    root.style.setProperty('--sidebar-width', `${width}px`);
    handle.setAttribute('aria-valuenow', String(width));
    if (persist) localStorage.setItem(storageKey, String(width));
  };

  apply(localStorage.getItem(storageKey) || defaultWidth, false);

  handle.addEventListener('pointerdown', (event) => {
    dragging = true;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('sidebar-resizing');
  });
  handle.addEventListener('pointermove', (event) => {
    if (dragging) apply(event.clientX);
  });
  const end = () => {
    dragging = false;
    document.body.classList.remove('sidebar-resizing');
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('dblclick', () => apply(defaultWidth));
  handle.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    apply(currentWidth() + (event.key === 'ArrowRight' ? 16 : -16));
  });
})();
