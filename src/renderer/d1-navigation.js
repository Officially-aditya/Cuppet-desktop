(() => {
  if (!window.cuppet?.sessions?.search) return;

  const searchButton = document.querySelector('#search-button');
  const projectList = document.querySelector('#project-list');
  const messages = document.querySelector('#messages');
  if (!searchButton || !projectList || !messages) return;

  const LAST_SESSION_KEY = 'cuppet.desktop.last-session';
  const SCROLL_PREFIX = 'cuppet.desktop.scroll.';
  let firstOpen = true;
  let searchVersion = 0;
  let selectedResult = 0;
  let currentResults = [];
  let userScrollIntent = false;
  let stickyToBottom = true;
  let preservedScrollTop = 0;

  const originalSessionButton = sessionButton;
  sessionButton = function d1SessionButton(session) {
    const button = originalSessionButton(session);
    button.dataset.sessionId = session.id;
    const row = document.createElement('div');
    row.className = 'session-row';
    row.dataset.sessionId = session.id;
    const menu = document.createElement('button');
    menu.type = 'button';
    menu.className = 'session-menu-button';
    menu.textContent = '⋯';
    menu.title = `Actions for ${session.title || 'chat'}`;
    menu.setAttribute('aria-label', `Actions for ${session.title || 'chat'}`);
    menu.addEventListener('click', (event) => {
      event.stopPropagation();
      showSessionMenu(session, menu.getBoundingClientRect());
    });
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showSessionMenu(session, { left: event.clientX, right: event.clientX, top: event.clientY, bottom: event.clientY });
    });
    row.append(button, menu);
    return row;
  };

  const originalRenderSidebar = renderSidebar;
  renderSidebar = function d1RenderSidebar() {
    originalRenderSidebar();
    decorateProjects();
  };

  const originalOpenSession = openSession;
  openSession = async function d1OpenSession(requestedId) {
    saveScroll();
    let id = requestedId;
    if (firstOpen) {
      firstOpen = false;
      const saved = localStorage.getItem(LAST_SESSION_KEY);
      if (saved && state.sessions.some((item) => item.id === saved)) id = saved;
    }
    const result = await originalOpenSession(id);
    if (state.active?.id) {
      localStorage.setItem(LAST_SESSION_KEY, state.active.id);
      restoreScroll(state.active.id);
    }
    return result;
  };

  searchButton.addEventListener('click', openSearch);
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openSearch();
      return;
    }
    if (event.key === 'Escape') hideContextMenu();
  });

  for (const type of ['wheel', 'touchstart', 'pointerdown']) messages.addEventListener(type, () => { userScrollIntent = true; }, { passive: true });
  messages.addEventListener('keydown', (event) => {
    if (['PageUp','PageDown','Home','End','ArrowUp','ArrowDown',' '].includes(event.key)) userScrollIntent = true;
  });
  messages.addEventListener('scroll', () => {
    if (!userScrollIntent) return;
    userScrollIntent = false;
    preservedScrollTop = messages.scrollTop;
    stickyToBottom = distanceFromBottom() < 90;
    messages.classList.toggle('user-scrolled', !stickyToBottom);
    const id = currentSessionId();
    if (id) localStorage.setItem(`${SCROLL_PREFIX}${id}`, String(Math.max(0, Math.round(preservedScrollTop))));
  }, { passive: true });

  const messageObserver = new MutationObserver(() => {
    if (stickyToBottom) return;
    requestAnimationFrame(() => {
      messages.scrollTop = Math.min(preservedScrollTop, Math.max(0, messages.scrollHeight - messages.clientHeight));
      messages.classList.add('user-scrolled');
    });
  });
  messageObserver.observe(messages, { childList: true, subtree: true, characterData: true });

  window.cuppet.onEvent((event) => {
    if (event?.type === 'session.archived' || event?.type === 'session.deleted' || event?.type === 'session.restored') void refreshData();
  });

  const contextMenu = document.createElement('div');
  contextMenu.className = 'nav-context-menu hidden';
  contextMenu.setAttribute('role', 'menu');
  document.body.append(contextMenu);
  document.addEventListener('pointerdown', (event) => {
    if (!contextMenu.contains(event.target) && !event.target.closest?.('.session-menu-button,.project-menu-button')) hideContextMenu();
  }, true);

  const renameDialog = document.createElement('dialog');
  renameDialog.className = 'rename-dialog';
  document.body.append(renameDialog);

  const searchDialog = document.createElement('dialog');
  searchDialog.className = 'search-dialog';
  searchDialog.innerHTML = `
    <div class="search-shell">
      <div class="search-header">
        <div class="search-input-wrap"><span aria-hidden="true">⌕</span><input class="search-input" type="search" maxlength="512" autocomplete="off" placeholder="Search chats and messages…" aria-label="Search chats and messages"></div>
        <button class="search-close" type="button" aria-label="Close">×</button>
      </div>
      <div class="search-options"><label><input class="search-archived" type="checkbox"> Include archived</label><span class="search-shortcut">⌘/Ctrl K · ↑↓ navigate · Enter open</span></div>
      <div class="search-results"><div class="search-state">Search local conversation titles and message text.</div></div>
    </div>`;
  document.body.append(searchDialog);
  const searchInput = searchDialog.querySelector('.search-input');
  const includeArchived = searchDialog.querySelector('.search-archived');
  const searchResults = searchDialog.querySelector('.search-results');
  searchDialog.querySelector('.search-close').addEventListener('click', () => searchDialog.close());
  includeArchived.addEventListener('change', () => void performSearch());
  let debounceTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void performSearch(), 110);
  });
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' && currentResults.length) {
      event.preventDefault(); selectedResult = (selectedResult + 1) % currentResults.length; renderSearchResults();
    } else if (event.key === 'ArrowUp' && currentResults.length) {
      event.preventDefault(); selectedResult = (selectedResult - 1 + currentResults.length) % currentResults.length; renderSearchResults();
    } else if (event.key === 'Enter' && currentResults[selectedResult]) {
      event.preventDefault(); void openSearchResult(currentResults[selectedResult]);
    }
  });

  function openSearch() {
    hideContextMenu();
    if (!searchDialog.open) searchDialog.showModal();
    searchInput.focus();
    searchInput.select();
    if (searchInput.value.trim()) void performSearch();
  }

  async function performSearch() {
    const query = searchInput.value.trim();
    const version = ++searchVersion;
    selectedResult = 0;
    if (!query) {
      currentResults = [];
      searchResults.innerHTML = '<div class="search-state">Search local conversation titles and message text.</div>';
      return;
    }
    searchResults.innerHTML = '<div class="search-state">Searching…</div>';
    try {
      const results = await window.cuppet.sessions.search(query, { limit: 60, includeArchived: includeArchived.checked });
      if (version !== searchVersion) return;
      currentResults = Array.isArray(results) ? results : [];
      renderSearchResults();
    } catch (error) {
      if (version !== searchVersion) return;
      currentResults = [];
      searchResults.replaceChildren(searchState(error?.message || String(error), true));
    }
  }

  function renderSearchResults() {
    if (!currentResults.length) {
      searchResults.innerHTML = '<div class="search-state">No matching local conversations found.</div>';
      return;
    }
    searchResults.replaceChildren(...currentResults.map((result, index) => searchResultNode(result, index)));
    searchResults.querySelector('.search-result.selected')?.scrollIntoView?.({ block: 'nearest' });
  }

  function searchResultNode(result, index) {
    const row = document.createElement('article');
    row.className = `search-result${index === selectedResult ? ' selected' : ''}`;
    const main = document.createElement('button');
    main.type = 'button'; main.className = 'search-result-main';
    main.addEventListener('click', () => void openSearchResult(result));
    const title = document.createElement('div'); title.className = 'search-result-title'; title.textContent = result.title || 'New chat';
    if (result.archivedAt) { const badge = document.createElement('span'); badge.className = 'archive-badge'; badge.textContent = 'Archived'; title.append(badge); }
    const meta = document.createElement('div'); meta.className = 'search-result-meta';
    const project = state.projects.find((item) => item.id === result.projectId);
    meta.textContent = [project?.name || (result.projectId ? 'Project' : 'General'), result.kind === 'message' ? `${result.role || 'message'}${result.sequence ? ` · #${result.sequence}` : ''}` : 'chat title'].join(' · ');
    const snippet = document.createElement('div'); snippet.className = 'search-result-snippet'; appendSnippet(snippet, result.snippet || (result.kind === 'session' ? 'Title match' : ''));
    main.append(title, meta, snippet); row.append(main);
    if (result.archivedAt) {
      const restore = document.createElement('button'); restore.type = 'button'; restore.className = 'search-result-action'; restore.textContent = 'Restore';
      restore.addEventListener('click', (event) => { event.stopPropagation(); void restoreArchived(result.sessionId, false); });
      row.append(restore);
    }
    return row;
  }

  async function openSearchResult(result) {
    try {
      if (result.archivedAt) await window.cuppet.sessions.restore(result.sessionId);
      if (result.archivedAt) await refreshData();
      await openSession(result.sessionId);
      searchDialog.close();
      if (result.kind === 'message' && result.itemId) {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const node = messages.querySelector(`[data-message-id="${cssEscapeD1(result.itemId)}"]`);
          if (!node) return;
          stickyToBottom = false;
          node.scrollIntoView({ block: 'center', behavior: 'smooth' });
          node.classList.remove('search-hit'); void node.offsetWidth; node.classList.add('search-hit');
          preservedScrollTop = messages.scrollTop;
        }));
      }
    } catch (error) { toast(error?.message || String(error)); }
  }

  async function restoreArchived(sessionId, openAfter = false) {
    try {
      await window.cuppet.sessions.restore(sessionId);
      await refreshData();
      toast('Chat restored.');
      if (openAfter) await openSession(sessionId);
      if (searchInput.value.trim()) await performSearch();
    } catch (error) { toast(error?.message || String(error)); }
  }

  function showSessionMenu(session, anchor) {
    showContextMenu([
      { label: 'Rename chat', action: () => void renameChat(session) },
      { label: 'Archive chat', action: () => void archiveChat(session) },
      { separator: true },
      { label: 'Delete chat…', danger: true, action: () => void deleteChat(session) },
    ], anchor);
  }

  function showProjectMenu(project, anchor) {
    showContextMenu([
      { label: 'Rename project', action: () => void renameProject(project) },
      { separator: true },
      { label: 'Remove registration…', danger: true, action: () => void removeProjectFromMenu(project) },
    ], anchor);
  }

  function showContextMenu(items, anchor) {
    contextMenu.replaceChildren();
    for (const item of items) {
      if (item.separator) { contextMenu.append(document.createElement('hr')); continue; }
      const button = document.createElement('button'); button.type = 'button'; button.textContent = item.label; button.classList.toggle('danger', item.danger === true);
      button.addEventListener('click', () => { hideContextMenu(); item.action(); }); contextMenu.append(button);
    }
    contextMenu.classList.remove('hidden');
    const x = Math.min(anchor.right ?? anchor.left ?? 0, window.innerWidth - 190);
    const y = Math.min(anchor.bottom ?? anchor.top ?? 0, window.innerHeight - Math.max(70, contextMenu.offsetHeight) - 10);
    contextMenu.style.left = `${Math.max(8, x)}px`; contextMenu.style.top = `${Math.max(8, y)}px`;
  }

  function hideContextMenu() { contextMenu.classList.add('hidden'); }

  function decorateProjects() {
    const groups = [...projectList.querySelectorAll('.project-group:not(.general-group)')];
    for (let index = 0; index < Math.min(groups.length, state.projects.length); index++) {
      const project = state.projects[index]; const row = groups[index].querySelector('.project-row');
      if (!row || row.querySelector('.project-menu-button')) continue;
      row.dataset.projectId = project.id;
      const menu = document.createElement('button'); menu.type = 'button'; menu.className = 'project-menu-button'; menu.textContent = '⋯'; menu.title = `Actions for ${project.name}`;
      menu.addEventListener('click', (event) => { event.stopPropagation(); showProjectMenu(project, menu.getBoundingClientRect()); });
      row.append(menu);
    }
  }

  async function renameChat(session) {
    const title = await requestRename('Rename chat', session.title || 'New chat', 160);
    if (!title || title === session.title) return;
    try { await window.cuppet.sessions.rename(session.id, title); await refreshData(); if (state.active?.id === session.id) await openSession(session.id); }
    catch (error) { toast(error?.message || String(error)); }
  }

  async function archiveChat(session) {
    if (!window.confirm(`Archive “${session.title || 'New chat'}”? You can restore it from Search.`)) return;
    try {
      await window.cuppet.sessions.archive(session.id);
      localStorage.removeItem(`${SCROLL_PREFIX}${session.id}`);
      if (state.active?.id === session.id) { state.active = null; delete document.body.dataset.cuppetSessionId; }
      await refreshData(); await openFallback(session.projectId); toast('Chat archived.');
    } catch (error) { toast(error?.message || String(error)); }
  }

  async function deleteChat(session) {
    if (!window.confirm(`Delete “${session.title || 'New chat'}” permanently? This removes its local transcript and cannot be undone.`)) return;
    try {
      await window.cuppet.sessions.delete(session.id);
      localStorage.removeItem(`${SCROLL_PREFIX}${session.id}`);
      if (localStorage.getItem(LAST_SESSION_KEY) === session.id) localStorage.removeItem(LAST_SESSION_KEY);
      if (state.active?.id === session.id) { state.active = null; delete document.body.dataset.cuppetSessionId; }
      await refreshData(); await openFallback(session.projectId); toast('Chat deleted.');
    } catch (error) { toast(error?.message || String(error)); }
  }

  async function renameProject(project) {
    const name = await requestRename('Rename project', project.name, 120);
    if (!name || name === project.name) return;
    try { await window.cuppet.projects.rename(project.id, name); await refreshData(); }
    catch (error) { toast(error?.message || String(error)); }
  }

  async function removeProjectFromMenu(project) {
    if (!window.confirm(`Remove ${project.name} from Cuppet? Files stay on disk and chats remain as local history.`)) return;
    try { await window.cuppet.projects.remove(project.id); await refreshData(); if (state.selectedProjectId === project.id) startDraft(null); }
    catch (error) { toast(error?.message || String(error)); }
  }

  async function openFallback(preferredProjectId) {
    const projectSession = state.sessions.find((item) => item.projectId === preferredProjectId);
    const next = projectSession || state.sessions[0];
    if (next) await openSession(next.id);
    else startDraft(state.projects.some((item) => item.id === preferredProjectId) ? preferredProjectId : null);
  }

  function requestRename(title, current, maxLength) {
    renameDialog.replaceChildren();
    const heading = document.createElement('h2'); heading.textContent = title;
    const input = document.createElement('input'); input.type = 'text'; input.maxLength = maxLength; input.value = current || '';
    const actions = document.createElement('div'); actions.className = 'rename-dialog-actions';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'ghost-button'; cancel.textContent = 'Cancel';
    const save = document.createElement('button'); save.type = 'button'; save.className = 'primary-button'; save.textContent = 'Save';
    actions.append(cancel, save); renameDialog.append(heading, input, actions);
    return new Promise((resolve) => {
      let done = false; const finish = (value) => { if (done) return; done = true; if (renameDialog.open) renameDialog.close(); resolve(value); };
      cancel.addEventListener('click', () => finish(null));
      save.addEventListener('click', () => { const value = input.value.trim(); if (value) finish(value); else input.focus(); });
      input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); save.click(); } });
      renameDialog.addEventListener('cancel', () => finish(null), { once: true });
      renameDialog.showModal(); input.focus(); input.select();
    });
  }

  function saveScroll() {
    const id = currentSessionId(); if (!id) return;
    const top = stickyToBottom ? messages.scrollHeight : preservedScrollTop;
    localStorage.setItem(`${SCROLL_PREFIX}${id}`, String(Math.max(0, Math.round(top))));
  }

  function restoreScroll(sessionId) {
    const raw = localStorage.getItem(`${SCROLL_PREFIX}${sessionId}`);
    if (raw == null) { stickyToBottom = true; messages.classList.remove('user-scrolled'); return; }
    const desired = Math.max(0, Number(raw) || 0);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      messages.scrollTop = Math.min(desired, Math.max(0, messages.scrollHeight - messages.clientHeight));
      preservedScrollTop = messages.scrollTop;
      stickyToBottom = distanceFromBottom() < 90;
      messages.classList.toggle('user-scrolled', !stickyToBottom);
    }));
  }

  function distanceFromBottom() { return Math.max(0, messages.scrollHeight - messages.clientHeight - messages.scrollTop); }
  function currentSessionId() { return String(document.body.dataset.cuppetSessionId || ''); }

  function appendSnippet(target, value) {
    const text = String(value || ''); let cursor = 0;
    for (const match of text.matchAll(/\[([^\]]+)\]/g)) {
      if (match.index > cursor) target.append(document.createTextNode(text.slice(cursor, match.index)));
      const mark = document.createElement('mark'); mark.textContent = match[1]; target.append(mark); cursor = match.index + match[0].length;
    }
    if (cursor < text.length) target.append(document.createTextNode(text.slice(cursor)));
  }

  function searchState(message, retry) {
    const node = document.createElement('div'); node.className = 'search-state'; node.append(document.createTextNode(message));
    if (retry) { const button = document.createElement('button'); button.type = 'button'; button.className = 'ghost-button'; button.textContent = 'Retry'; button.addEventListener('click', () => void performSearch()); node.append(document.createElement('br'), button); }
    return node;
  }

  function cssEscapeD1(value) { return globalThis.CSS?.escape ? CSS.escape(String(value)) : String(value).replace(/[^A-Za-z0-9_-]/g, '\\$&'); }
})();
