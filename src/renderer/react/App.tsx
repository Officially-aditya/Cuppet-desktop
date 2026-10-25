import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  Attachment,
  CognitiveStatus,
  CommandDefinition,
  CommandResult,
  PermissionRequest,
  Project,
  QuestionRequest,
  QueuedTurn,
  RuntimeEvent,
  Session,
} from '../types';
import { Sidebar } from './Sidebar';
import { askConfirm } from './dialog-store';
import { ShellPanelControls } from './ShellPanelControls';
import { ChatPane, type ComposerMode, type DeliveryMode } from './ChatPane';
import { TstMemorySidebar } from './TstMemorySidebar';
import { NewChatModal } from './NewChatModal';
import { AddProjectModal } from './AddProjectModal';
import { SearchModal } from './SearchModal';
import { RemoteModal } from './RemoteModal';
import { SettingsModal } from './SettingsModal';
import { Toast } from './Toast';
import { CUPPET_LOGO_URL } from './brand';
import {
  hydrateClientRunSession,
  hydrateClientRunState,
  markClientRunStarted,
  useClientRunState,
} from './client-run-state';
import {
  hydrateClientProviderSettings,
  refreshClientProviderSettings,
  useClientProviderSettings,
} from './client-provider-state';
import {
  addPendingUserMessage,
  removePendingUserMessage,
  refreshClientSession,
  refreshClientSessions,
  setViewedClientSession,
  upsertClientSession,
  useClientSessions,
  useClientUnreadSessions,
} from './client-session-state';

const LAST_SESSION_KEY = 'cuppet.desktop.last-session';

type Draft = { projectId: string | null; mode: 'plan' | 'build' };
type ModalName = 'new-chat' | 'add-project' | 'search' | 'remote' | 'settings' | null;

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>({ projectId: null, mode: 'build' });
  const [sessionLoading, setSessionLoading] = useState(false);
  const switchRequest = useRef(0);
  const modeRequest = useRef(0);
  const loadedSessionIds = useRef(new Set<string>());
  const previousSelection = useRef<{ sessionId: string | null; draft: Draft | null; mode: 'plan' | 'build' }>({
    sessionId: null, draft: { projectId: null, mode: 'build' }, mode: 'build',
  });
  const [cognitive, setCognitive] = useState<CognitiveStatus>({ orchestratorEnabled: false, backgroundPaused: false, tst: {} });
  const [mode, setMode] = useState<'plan' | 'build'>('build');
  const [commands, setCommands] = useState<CommandDefinition[]>([]);
  const [permissions, setPermissions] = useState<PermissionRequest[]>([]);
  const [questions, setQuestions] = useState<QuestionRequest[]>([]);
  const permission = permissions.find((request) => !request.sessionId || request.sessionId === activeSessionId) ?? null;
  const question = questions.find((request) => !request.sessionId || request.sessionId === activeSessionId) ?? null;
  const waitingSessionIds = useMemo(() => new Set([...permissions, ...questions].map((request) => request.sessionId).filter((id): id is string => Boolean(id))), [permissions, questions]);
  const [queuedTurns, setQueuedTurns] = useState<QueuedTurn[]>([]);
  const [modal, setModal] = useState<ModalName>(null);
  const [projectSource, setProjectSource] = useState<'local' | 'github'>('local');
  const [settingsSection, setSettingsSection] = useState('general');
  const [toast, setToast] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('cuppet.desktop.sidebar-collapsed') === '1');
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const sessions = useClientSessions();
  const unreadSessionIds = useClientUnreadSessions();
  const running = useClientRunState();
  const provider = useClientProviderSettings();
  const active = useMemo(() => activeSessionId ? sessions.find((session) => session.id === activeSessionId) ?? null : null, [activeSessionId, sessions]);

  const activeProjectId = active?.projectId ?? draft?.projectId ?? null;
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
  const activeRunning = Boolean(activeSessionId && running.has(activeSessionId));
  const activeComposerMode: ComposerMode = cognitive.orchestratorEnabled ? 'orchestrate' : mode;

  useLayoutEffect(() => {
    const start = `chat-switch:${switchRequest.current}:start`;
    if (activeSessionId && !sessionLoading && globalThis.performance?.getEntriesByName(start).length) {
      performance.mark(`chat-switch:${switchRequest.current}:ready`);
      performance.measure('chat-switch', start, `chat-switch:${switchRequest.current}:ready`);
      performance.clearMarks(start);
      performance.clearMarks(`chat-switch:${switchRequest.current}:ready`);
    }
  }, [activeSessionId, sessionLoading]);

  useEffect(() => {
    if (activeProjectId) void window.cuppet.projects.open(activeProjectId).catch(() => undefined);
  }, [activeProjectId]);

  useEffect(() => {
    const updateViewedSession = () => {
      setViewedClientSession(!loading && !modal && !document.hidden && document.hasFocus() ? activeSessionId : null);
    };
    updateViewedSession();
    window.addEventListener('focus', updateViewedSession);
    window.addEventListener('blur', updateViewedSession);
    document.addEventListener('visibilitychange', updateViewedSession);
    return () => {
      window.removeEventListener('focus', updateViewedSession);
      window.removeEventListener('blur', updateViewedSession);
      document.removeEventListener('visibilitychange', updateViewedSession);
      setViewedClientSession(null);
    };
  }, [activeSessionId, loading, modal]);

  const showToast = useCallback((message: unknown) => {
    setToast(message instanceof Error ? message.message : String(message ?? ''));
  }, []);

  const refreshLists = useCallback(async () => {
    const [nextProjects, nextSessions] = await Promise.all([
      window.cuppet.projects.list(),
      refreshClientSessions(),
    ]);
    setProjects(nextProjects);
    hydrateClientRunState(nextSessions);
    return { nextProjects, nextSessions };
  }, []);

  const openSession = useCallback(async (sessionId: string) => {
    const token = ++switchRequest.current;
    const modeToken = ++modeRequest.current;
    const previous = previousSelection.current;
    globalThis.performance?.mark(`chat-switch:${token}:start`);
    setActiveSessionId(sessionId);
    setDraft(null);
    setMode('build');
    setSessionLoading(!loadedSessionIds.current.has(sessionId));
    let nextMode: 'plan' | 'build' = 'build';
    void window.cuppet.cognitive.modeGet(sessionId).then((state) => {
      if (token !== switchRequest.current || modeToken !== modeRequest.current) return;
      nextMode = state.mode === 'plan' ? 'plan' : 'build';
      setMode(nextMode);
      if (previousSelection.current.sessionId === sessionId) previousSelection.current.mode = nextMode;
    }).catch((error) => { if (token === switchRequest.current) showToast(error); });
    try {
      const session = await refreshClientSession(sessionId, { limit: 60 });
      loadedSessionIds.current.add(sessionId);
      if (token !== switchRequest.current) return;
      previousSelection.current = { sessionId: session.id, draft: null, mode: nextMode };
      setSessionLoading(false);
      localStorage.setItem(LAST_SESSION_KEY, session.id);
      hydrateClientRunSession(session);
    } catch (error) {
      if (token !== switchRequest.current) return;
      ++modeRequest.current;
      setActiveSessionId(previous.sessionId);
      setDraft(previous.draft);
      setMode(previous.mode);
      setSessionLoading(false);
      showToast(error);
      globalThis.performance?.clearMarks(`chat-switch:${token}:start`);
    } finally {
      if (token !== switchRequest.current) globalThis.performance?.clearMarks(`chat-switch:${token}:start`);
    }
  }, [showToast]);

  const startDraft = useCallback((projectId: string | null = null) => {
    ++switchRequest.current;
    ++modeRequest.current;
    previousSelection.current = { sessionId: null, draft: { projectId, mode: 'build' }, mode: 'build' };
    setActiveSessionId(null);
    setDraft({ projectId, mode: 'build' });
    setMode('build');
    setSessionLoading(false);
  }, []);

  const ensureActiveSession = useCallback(async (activate = true) => {
    if (active) return active;
    const projectId = draft?.projectId ?? null;
    const created = await window.cuppet.sessions.create(projectId);
    if (draft?.mode === 'plan') await window.cuppet.cognitive.modeSet(created.id, 'plan');
    const session = { ...created, messages: created.messages ?? [] };
    upsertClientSession(session);
    if (activate) {
      ++switchRequest.current;
      ++modeRequest.current;
      loadedSessionIds.current.add(session.id);
      previousSelection.current = { sessionId: session.id, draft: null, mode: draft?.mode ?? 'build' };
      setActiveSessionId(session.id);
      setDraft(null);
      setMode(draft?.mode ?? 'build');
      setSessionLoading(false);
      localStorage.setItem(LAST_SESSION_KEY, session.id);
    }
    hydrateClientRunSession(session);
    return session;
  }, [active, draft]);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const [health, nextProjects, nextSessions, nextCognitive, nextCommands] = await Promise.all([
          window.cuppet.health(),
          window.cuppet.projects.list(),
          refreshClientSessions(),
          window.cuppet.cognitive.status(),
          window.cuppet.commands.list(),
          refreshClientProviderSettings(),
        ]);
        if (disposed) return;
        if (!health?.ok) showToast('Runtime unavailable');
        setProjects(nextProjects);
        setCognitive(nextCognitive);
        setCommands(nextCommands);
        hydrateClientRunState(nextSessions);
        const saved = localStorage.getItem(LAST_SESSION_KEY);
        const initial = (saved && nextSessions.find((session) => session.id === saved)) || nextSessions[0];
        if (initial) await openSession(initial.id);
        else startDraft(null);
        const pendingPermissions = await window.cuppet.permissions.list().catch(() => []);
        const pendingQuestions = await window.cuppet.questions.list().catch(() => []);
        if (!disposed) {
          setPermissions(pendingPermissions);
          setQuestions(pendingQuestions);
        }
      } catch (error) {
        if (!disposed) showToast(error);
      } finally {
        if (!disposed) setLoading(false);
      }
    })();
    return () => { disposed = true; };
  }, [openSession, showToast, startDraft]);

  useEffect(() => window.cuppet.native.onOpenSession?.((id) => {
    setModal(null);
    void openSession(id).catch(showToast);
  }), [openSession, showToast]);

  const openFolder = useCallback(async () => {
    try {
      const path = await window.cuppet.native.chooseFolder({ title: 'Open a project folder', buttonLabel: 'Open folder' });
      if (!path) return;
      const project = await window.cuppet.projects.addLocal({ path });
      await refreshLists();
      startDraft(project.id);
    } catch (error) { showToast(error); }
  }, [refreshLists, showToast, startDraft]);

  const handleEvent = useCallback(async (event: RuntimeEvent) => {
    if (!event?.type) return;

    if (event.type === 'pe3.routed' && event.targetSessionId) {
      const target = String(event.targetSessionId);
      if (activeSessionId === event.sourceSessionId) void openSession(target).catch(showToast);
    }
    if (event.type === 'runtime.error') showToast(event.message || 'Runtime error');
    if (event.type === 'cognitive.updated' && event.cognitive) setCognitive(event.cognitive);
    if (event.type === 'context.compiled' && event.tst) setCognitive((current) => ({ ...current, tst: event.tst }));
    if (event.project) setProjects((current) => upsertProject(current, event.project));
    if (event.type === 'project.removed' && event.projectId) {
      setProjects((current) => current.filter((project) => project.id !== event.projectId));
      void refreshLists();
    }

    if (event.type === 'permission.requested' && event.request) setPermissions((current) => [...current.filter((request) => request.id !== event.request.id), event.request]);
    if (event.type === 'permission.resolved') setPermissions((current) => current.filter((request) => request.id !== event.requestId));
    if (event.type === 'question.requested' && event.request) setQuestions((current) => [...current.filter((request) => request.id !== event.request.id), event.request]);
    if (event.type === 'question.resolved') setQuestions((current) => current.filter((request) => request.id !== event.requestId));

    if (event.type === 'queue.queued' && activeSessionId && event.sessionId === activeSessionId) {
      void window.cuppet.sessions.queueList(activeSessionId).then((list) => {
        if (Array.isArray(list)) setQueuedTurns(list);
      }).catch(() => undefined);
    }
    if ((event.type === 'queue.dispatched' || event.type === 'queue.cancelled') && event.sessionId === activeSessionId) {
      setQueuedTurns((current) => current.filter((item) => item.id !== event.queueId));
    }
  }, [activeSessionId, openSession, refreshLists, showToast]);

  useEffect(() => window.cuppet.onEvent((event) => {
    void handleEvent(event);
  }), [handleEvent]);

  useEffect(() => {
    if (!activeSessionId) {
      setQueuedTurns([]);
      return;
    }
    let cancelled = false;
    window.cuppet.sessions.queueList(activeSessionId)
      .then((list) => {
        if (!cancelled && Array.isArray(list)) setQueuedTurns(list);
      })
      .catch(() => {
        if (!cancelled) setQueuedTurns([]);
      });
    return () => { cancelled = true; };
  }, [activeSessionId]);

  const selectProject = useCallback(async (projectId: string) => {
    const project = projects.find((item) => item.id === projectId);
    if (!project) return;
    const latest = sessions
      .filter((session) => session.projectId === projectId)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
    if (latest) await openSession(latest.id);
    else startDraft(projectId);
  }, [openSession, projects, sessions, startDraft]);

  const executeCommand = useCallback(async (raw: string, definition?: CommandDefinition) => {
    const def = definition ?? commandForRaw(commands, raw);
    let sessionId = activeSessionId;
    if (def?.requiresSession && !sessionId) sessionId = (await ensureActiveSession()).id;
    const result = await window.cuppet.commands.execute(sessionId, raw);
    if ((result.id === 'plan' || result.id === 'cuppet.plan.agent') && result.result && typeof result.result === 'object') {
      const nextMode = (result.result as { mode?: string }).mode;
      if (nextMode === 'plan' || nextMode === 'build') setMode(nextMode);
    }
    return result;
  }, [activeSessionId, commands, ensureActiveSession]);

  const cancelQueued = useCallback(async (queueId: string) => {
    if (!activeSessionId) return;
    try {
      await window.cuppet.sessions.queueCancel(queueId, activeSessionId);
      setQueuedTurns((current) => current.filter((item) => item.id !== queueId));
    } catch (error) {
      showToast(error);
    }
  }, [activeSessionId, showToast]);

  const steerQueued = useCallback(async (turn: QueuedTurn) => {
    if (!activeSessionId) return;
    const text = String(turn.params?.text ?? '').trim();
    if (!text) {
      showToast('Cannot steer with an empty message.');
      return;
    }
    let pendingId: string | undefined;
    try {
      await window.cuppet.sessions.queueCancel(turn.id, activeSessionId);
      setQueuedTurns((current) => current.filter((item) => item.id !== turn.id));
      const attachments = Array.isArray(turn.params?.attachments) ? turn.params.attachments : [];
      pendingId = addPendingUserMessage({ sessionId: activeSessionId, kind: 'steer', content: text, attachments });
      await window.cuppet.commands.execute(activeSessionId, {
        id: 'cuppet.steer.interrupt',
        input: {
          text,
          ...(Array.isArray(turn.params?.attachments) && turn.params.attachments.length ? { attachments: turn.params.attachments } : {}),
        },
      });
    } catch (error) {
      if (pendingId) removePendingUserMessage(pendingId);
      showToast(error);
    }
  }, [activeSessionId, showToast]);

  const send = useCallback(async (text: string, deliveryMode: DeliveryMode = 'queue', attachments: Attachment[] = []) => {
    if (sessionLoading) return { clear: false };
    const trimmed = text.trim();
    const value = trimmed || (attachments.length ? `Attached: ${attachments.map((item) => item.name).join(', ')}` : '');
    if (!value) return { clear: false };
    let pendingId: string | undefined;
    try {
      if (trimmed.startsWith('/')) {
        if (attachments.length) throw new Error('Attachments cannot be sent with slash commands.');
        const definition = commandForRaw(commands, trimmed);
        if (!definition) throw new Error(`Unknown Cuppet command: ${trimmed.split(/\s/, 1)[0]}`);
        const result = await executeCommand(trimmed, definition);
        return { clear: true, commandResult: result };
      }

      if (!provider?.configured || !provider?.credentialConfigured || !provider?.primary?.modelID) {
        setSettingsSection('platform');
        setModal('settings');
        showToast(provider?.requiresChatGPTAuth ? 'Connect ChatGPT before sending.' : 'Configure a provider before sending.');
        return { clear: false };
      }

      // Keep the draft visible until its first prompt has been saved and loaded.
      const session = await ensureActiveSession(false);
      const project = projects.find((item) => item.id === session.projectId);
      if (project?.missing) throw new Error(`Relocate ${project.name} before continuing.`);

      if (running.has(session.id)) {
        if (deliveryMode === 'steer') {
          pendingId = addPendingUserMessage({ sessionId: session.id, kind: 'steer', content: value, attachments });
          await window.cuppet.commands.execute(session.id, {
            id: 'cuppet.steer.interrupt', input: { text: value, ...(attachments.length ? { attachments } : {}) },
          });
        } else {
          const res = await window.cuppet.sessions.send(session.id, value, attachments);
          if (res?.queued) {
            setQueuedTurns((current) => [
              ...current,
              {
                id: res.queueId || `queue_${Date.now()}`,
                sessionId: session.id,
                params: { text: value, attachments },
                status: 'queued',
                queuedAt: Date.now(),
              },
            ]);
          }
        }
        return { clear: true };
      }

      pendingId = addPendingUserMessage({ sessionId: session.id, kind: 'send', content: value, attachments });
      const result = await window.cuppet.sessions.send(session.id, value, attachments);
      const target = String(result?.sessionId || session.id);
      markClientRunStarted(target);
      if (target !== activeSessionId) await openSession(target);
      return { clear: true };
    } catch (error) {
      if (pendingId) removePendingUserMessage(pendingId);
      if (String(error instanceof Error ? error.message : error).includes('Settings > General > Integrations')) {
        setSettingsSection('general');
        setModal('settings');
      }
      showToast(error);
      return { clear: false };
    }
  }, [activeSessionId, commands, ensureActiveSession, executeCommand, openSession, projects, provider, running, sessionLoading, showToast]);

  const stop = useCallback(async () => {
    if (!activeSessionId || !running.has(activeSessionId)) return;
    try { await window.cuppet.sessions.stop(activeSessionId); }
    catch (error) { showToast(error); }
  }, [activeSessionId, running, showToast]);

  const removeProject = useCallback(async (project: Project) => {
    const confirmed = await askConfirm({
      title: `Remove ${project.name}?`,
      message: 'It is removed from Cuppet only. The files stay on disk and its chats remain local.',
      confirmLabel: 'Remove project',
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await window.cuppet.projects.remove(project.id);
      const { nextSessions } = await refreshLists();
      if (activeProjectId === project.id) {
        const next = nextSessions.find((session) => session.projectId !== project.id);
        if (next) await openSession(next.id); else startDraft(null);
      }
      showToast(`Removed ${project.name}.`);
    } catch (error) { showToast(error); }
  }, [activeProjectId, openSession, refreshLists, showToast, startDraft]);

  const renameProject = useCallback(async (project: Project, name: string) => {
    const value = name.trim();
    if (!value || value === project.name) return;
    try { await window.cuppet.projects.rename(project.id, value); await refreshLists(); }
    catch (error) { showToast(error); throw error; }
  }, [refreshLists, showToast]);

  const archiveSession = useCallback(async (session: Session) => {
    const confirmed = await askConfirm({ title: `Archive “${session.title || 'New chat'}”?`, confirmLabel: 'Archive' });
    if (!confirmed) return;
    try {
      await window.cuppet.sessions.archive(session.id);
      const nextSessions = await refreshClientSessions();
      if (activeSessionId === session.id) {
        const next = nextSessions.find((item) => item.id !== session.id);
        if (next) await openSession(next.id); else startDraft(session.projectId ?? null);
      }
    } catch (error) { showToast(error); }
  }, [activeSessionId, openSession, showToast, startDraft]);

  const deleteSession = useCallback((session: Session) => {
    if (activeSessionId === session.id) startDraft(session.projectId ?? null);
    // Let the confirmation close and the draft render while deletion finishes.
    void (async () => {
      try {
        await window.cuppet.sessions.delete(session.id);
        await refreshClientSessions();
        showToast(`Deleted “${session.title || 'New chat'}”.`);
      } catch (error) {
        showToast(error);
      }
    })();
  }, [activeSessionId, refreshClientSessions, showToast, startDraft]);

  const changeMode = useCallback(async (next: ComposerMode) => {
    ++modeRequest.current;
    const sessionMode: 'plan' | 'build' = next === 'plan' ? 'plan' : 'build';
    const orchestratorEnabled = next === 'orchestrate';
    try {
      if (activeSessionId) await window.cuppet.cognitive.modeSet(activeSessionId, sessionMode);
      else setDraft((current) => current ? { ...current, mode: sessionMode } : current);
      setMode(sessionMode);
      previousSelection.current = { ...previousSelection.current, mode: sessionMode };
      await window.cuppet.cognitive.orchestratorSet(orchestratorEnabled);
      setCognitive((current) => ({ ...current, orchestratorEnabled }));
    } catch (error) { showToast(error); }
  }, [activeSessionId, showToast]);

  const resolvePermission = useCallback(async (reply: 'once' | 'always' | 'reject', enableAuto = false) => {
    if (!permission) return;
    try {
      if (enableAuto && permission.autoEligible && permission.sessionId) await window.cuppet.permissions.autoSet(permission.sessionId, true);
      await window.cuppet.permissions.reply(permission.id, enableAuto ? 'once' : reply);
      setPermissions(await window.cuppet.permissions.list());
    } catch (error) { showToast(error); }
  }, [permission, showToast]);

  const answerQuestion = useCallback(async (answers: string[][] | null) => {
    if (!question) return;
    try {
      if (answers) await window.cuppet.questions.reply(question.id, answers);
      else await window.cuppet.questions.reject(question.id);
      setQuestions(await window.cuppet.questions.list());
    } catch (error) { showToast(error); }
  }, [question, showToast]);

  const generalSessions = useMemo(() => sessions.filter((session) => !session.projectId && !session.archivedAt), [sessions]);
  const visibleSessions = useMemo(() => sessions.filter((session) => !session.archivedAt), [sessions]);
  const openNewChat = useCallback(() => setModal('new-chat'), []);
  const openSearch = useCallback(() => setModal('search'), []);
  const openRemote = useCallback(() => setModal('remote'), []);
  const openSettings = useCallback(() => { setSettingsSection('general'); setModal('settings'); }, []);
  const openAddProject = useCallback(() => { setProjectSource('local'); setModal('add-project'); }, []);
  const openProjectGraph = useCallback((projectId: string) => {
    if (activeProjectId === projectId) setMemoryOpen((current) => !current);
    else { selectProject(projectId); setMemoryOpen(true); }
  }, [activeProjectId, selectProject]);
  const panels = { sidebar: !sidebarCollapsed, memory: memoryOpen, terminal: terminalOpen };

  if (loading) return <div className="react-boot"><div className="react-boot-brand"><img src={CUPPET_LOGO_URL} alt="" aria-hidden="true" /><span>Starting Cuppet…</span></div></div>;

  return (
    <div className="app-shell react-app">
      <Sidebar
        onError={showToast}
        projects={projects}
        sessions={visibleSessions}
        generalSessions={generalSessions}
        activeSessionId={activeSessionId}
        unreadSessionIds={unreadSessionIds}
        waitingSessionIds={waitingSessionIds}
        selectedProjectId={activeProjectId}
        collapsed={sidebarCollapsed}
        onCollapsedChange={setSidebarCollapsed}
        onNewChat={openNewChat}
        onNewProjectChat={startDraft}
        onSearch={openSearch}
        onRemote={openRemote}
        onSettings={openSettings}
        onAddProject={openAddProject}
        onProject={selectProject}
        onSession={openSession}
        onRenameProject={renameProject}
        onRemoveProject={removeProject}
        onArchiveSession={archiveSession}
        onDeleteSession={deleteSession}
        isGraphOpen={panels.memory}
        onOpenProjectGraph={openProjectGraph}
      />
      <ChatPane
        session={active}
        loading={sessionLoading}
        draft={draft}
        project={activeProject}
        mode={mode}
        activeMode={activeComposerMode}
        running={activeRunning}
        commands={commands}
        activity={[]}
        terminalOpen={panels.terminal}
        queuedTurns={queuedTurns}
        onCancelQueued={cancelQueued}
        onSteerQueued={steerQueued}
        onTerminalOpenChange={setTerminalOpen}
        onOpenFolder={() => void openFolder()}
        onCloneRepository={() => { setProjectSource('github'); setModal('add-project'); }}
        onConfigureProvider={() => { setSettingsSection('platform'); setModal('settings'); }}
        onSend={send}
        onStop={stop}
        onModeChange={changeMode}
        question={question}
        onAnswerQuestion={answerQuestion}
        permission={!modal && (!permission?.sessionId || permission.sessionId === activeSessionId) ? permission : null}
        onResolvePermission={resolvePermission}
      />
      {active?.projectId && <TstMemorySidebar sessionId={active.id} projectName={activeProject?.name} running={activeRunning} open={panels.memory} onOpenChange={setMemoryOpen} />}

      {modal === 'new-chat' && <NewChatModal projects={projects} selectedProjectId={activeProjectId} onClose={() => setModal(null)} onStart={(projectId) => { startDraft(projectId); setModal(null); }} />}
      {modal === 'add-project' && <AddProjectModal initialSource={projectSource} onClose={() => setModal(null)} onAdded={async (project) => { await refreshLists(); startDraft(project.id); setModal(null); }} onError={showToast} />}
      {modal === 'search' && <SearchModal projects={projects} onClose={() => setModal(null)} onOpen={async (id) => { await openSession(id); setModal(null); }} onChanged={refreshLists} onError={showToast} />}
      {modal === 'remote' && <RemoteModal onClose={() => setModal(null)} onError={showToast} />}
      {modal === 'settings' && <SettingsModal provider={provider} initialSection={settingsSection} onClose={() => setModal(null)} onSaved={hydrateClientProviderSettings} onOpenRemote={() => setModal('remote')} onError={showToast} />}
      <ShellPanelControls
        project={activeProject}
        state={{
          leftAvailable: true,
          leftOpen: panels.sidebar,
          rightAvailable: Boolean(active?.projectId),
          rightOpen: panels.memory,
          bottomAvailable: true,
          bottomOpen: panels.terminal,
        }}
        onToggleLeft={() => setSidebarCollapsed((current) => !current)}
        onToggleRight={() => setMemoryOpen((current) => !current)}
        onToggleBottom={() => setTerminalOpen((current) => !current)}
      />
      <Toast message={toast} onClear={() => setToast(null)} />
    </div>
  );
}

function commandForRaw(commands: CommandDefinition[], raw: string) {
  const name = raw.trim().slice(1).split(/\s/, 1)[0]?.toLowerCase();
  return commands.find((item) => item.slash === name || item.aliases?.includes(name)) ?? null;
}

function upsertProject(values: Project[], value: Project) {
  const next = [...values];
  const index = next.findIndex((item) => item.id === value.id);
  if (index >= 0) next[index] = { ...next[index], ...value };
  else next.unshift(value);
  return next.sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0));
}
