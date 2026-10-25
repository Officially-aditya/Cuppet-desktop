export function createScrollFollower(node: HTMLElement) {
  let following = true;
  let frame: number | null = null;
  let programmaticTop: number | null = null;
  let lastTop = node.scrollTop;
  let lastHeight = node.scrollHeight;
  let anchor: { element: HTMLElement; top: number } | null = null;
  const restoreAnchor = () => {
    if (!anchor || !node.contains(anchor.element)) { anchor = null; return; }
    const delta = anchor.element.getBoundingClientRect().top - anchor.top;
    if (delta) {
      node.scrollTop += delta;
      programmaticTop = node.scrollTop;
    }
    lastTop = node.scrollTop;
    lastHeight = node.scrollHeight;
  };
  const pin = () => {
    if (!following) return;
    const bottom = Math.max(0, node.scrollHeight - node.clientHeight);
    if (node.scrollTop !== bottom) {
      node.scrollTop = bottom;
      programmaticTop = node.scrollTop;
    }
    lastTop = node.scrollTop;
    lastHeight = node.scrollHeight;
  };
  const schedule = () => {
    if ((!following && !anchor) || frame !== null) return;
    frame = requestAnimationFrame(() => { frame = null; if (anchor) restoreAnchor(); else pin(); });
  };

  // Pixel offsets go stale as deferred history changes height. Each visit starts
  // at the latest message and follows layout growth until the user scrolls away.
  pin();

  const onScroll = () => {
    const top = node.scrollTop;
    const height = node.scrollHeight;
    // A delayed event from our own pin can arrive after the next tool row grew.
    // Its distance from the bottom says nothing about the user's intent.
    if (top !== programmaticTop) {
      anchor = null;
      if (top < lastTop && height >= lastHeight) following = false;
      else if (height - node.clientHeight - top < 60) following = true;
    }
    programmaticTop = null;
    lastTop = top;
    lastHeight = height;
    schedule();
  };
  const onWheel = (event: WheelEvent) => { anchor = null; if (event.deltaY < 0) following = false; };
  const onKeyDown = (event: KeyboardEvent) => {
    anchor = null;
    if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) following = false;
  };
  let touchY = 0;
  const onTouchStart = (event: TouchEvent) => { anchor = null; touchY = event.touches[0]?.clientY ?? 0; };
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
    followLatest() { anchor = null; following = true; pin(); },
    preserveReadingPosition() {
      following = false;
      const top = node.getBoundingClientRect().top;
      const element = Array.from(node.querySelectorAll<HTMLElement>('[data-message-id]')).find(row => row.getBoundingClientRect().bottom > top);
      anchor = element ? { element, top: element.getBoundingClientRect().top } : null;
    },
    dispose() {
      if (frame !== null) cancelAnimationFrame(frame);
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
