export function createScrollFollower(node: HTMLElement, key: string | null) {
  let following = true;
  let frame: number | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let programmaticTop: number | null = null;
  let lastTop = node.scrollTop;
  let lastHeight = node.scrollHeight;
  let savedTop = lastTop;

  const persist = () => {
    if (key) try { localStorage.setItem(key, String(Math.round(savedTop))); } catch {}
  };
  const pin = () => {
    if (!following) return;
    const bottom = Math.max(0, node.scrollHeight - node.clientHeight);
    if (node.scrollTop !== bottom) {
      node.scrollTop = bottom;
      programmaticTop = node.scrollTop;
    }
    lastTop = savedTop = node.scrollTop;
    lastHeight = node.scrollHeight;
  };
  const schedule = () => {
    if (!following || frame !== null) return;
    frame = requestAnimationFrame(() => { frame = null; pin(); });
  };

  let saved: string | null = null;
  if (key) try { saved = localStorage.getItem(key); } catch {}
  if (saved !== null && Number.isFinite(Number(saved))) {
    node.scrollTop = Math.max(0, Number(saved));
    programmaticTop = lastTop = savedTop = node.scrollTop;
    following = node.scrollHeight - node.clientHeight - node.scrollTop < 60;
  } else pin();

  const onScroll = () => {
    const top = node.scrollTop;
    const height = node.scrollHeight;
    // A delayed event from our own pin can arrive after the next tool row grew.
    // Its distance from the bottom says nothing about the user's intent.
    if (top !== programmaticTop) {
      if (top < lastTop && height >= lastHeight) following = false;
      else if (height - node.clientHeight - top < 60) following = true;
    }
    programmaticTop = null;
    lastTop = savedTop = top;
    lastHeight = height;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 150);
    schedule();
  };
  const onWheel = (event: WheelEvent) => { if (event.deltaY < 0) following = false; };
  const onKeyDown = (event: KeyboardEvent) => {
    if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) following = false;
  };
  let touchY = 0;
  const onTouchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY ?? 0; };
  const onTouchMove = (event: TouchEvent) => {
    const nextY = event.touches[0]?.clientY ?? touchY;
    if (nextY > touchY) following = false;
    touchY = nextY;
  };
  node.addEventListener('scroll', onScroll, { passive: true });
  node.addEventListener('wheel', onWheel, { passive: true });
  node.addEventListener('keydown', onKeyDown);
  node.addEventListener('touchstart', onTouchStart, { passive: true });
  node.addEventListener('touchmove', onTouchMove, { passive: true });

  const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
  const observed = new Set<Element>();
  const observeChildren = () => {
    const children = new Set(Array.from(node.children));
    for (const child of observed) {
      if (!children.has(child)) { resize?.unobserve(child); observed.delete(child); }
    }
    for (const child of children) {
      if (!observed.has(child)) { resize?.observe(child); observed.add(child); }
    }
    schedule();
  };
  resize?.observe(node);
  observeChildren();
  const mutation = typeof MutationObserver === 'undefined' ? null : new MutationObserver(observeChildren);
  mutation?.observe(node, { childList: true });

  return {
    schedule,
    followLatest() { following = true; pin(); },
    dispose() {
      if (frame !== null) cancelAnimationFrame(frame);
      clearTimeout(saveTimer);
      savedTop = node.scrollTop;
      persist();
      resize?.disconnect();
      mutation?.disconnect();
      node.removeEventListener('scroll', onScroll);
      node.removeEventListener('wheel', onWheel);
      node.removeEventListener('keydown', onKeyDown);
      node.removeEventListener('touchstart', onTouchStart);
      node.removeEventListener('touchmove', onTouchMove);
    },
  };
}

export type ScrollFollower = ReturnType<typeof createScrollFollower>;
