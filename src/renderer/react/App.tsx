import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  Attachment,
  CognitiveStatus,
  CommandDefinition,
  CommandResult,
  Message,
  PermissionRequest,
  Project,
  ProviderSettings,
  QuestionRequest,
  RuntimeEvent,
  Session,
} from '../types';
import { Sidebar } from './Sidebar';
import { ChatPane, type ComposerMode, type DeliveryMode } from './ChatPane';
import { NewChatModal } from './NewChatModal';
import { AddProjectModal } from './AddProjectModal';
import { SearchModal } from './SearchModal';
import { RemoteModal } from './RemoteModal';
import { SettingsModal } from './SettingsModal';
import { PermissionModal } from './PermissionModal';
import { QuestionModal } from './QuestionModal';
import { Toast } from './Toast';
import { CUPPET_LOGO_URL } from './brand';
import {
  hydrateClientRunSession,
  hydrateClientRunState,
  markClientRunStarted,
  useClientRunState,
} from './client-run-state';

const LAST_SESSION_KEY = 'cuppet.desktop.last-session';

type Draft = { projectId: string | null; mode: 'plan' | 'build' };
type ModalName = 'new-chat' | 'add-project' | 'search' | 'remote' | 'settings' | null;

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [active, setActive] = useState<Session | null>(null);
  const [draft, setDraft] = useState<Draft | null>({ projectId: null, mode: 'build' });
  const [provider, setProvider] = useState<ProviderSettings | null>(null);
  const [cognitive, setCognitive] = useState<CognitiveStatus>({ orchestratorEnabled: false, backgroundPaused: false, tst: {} });
  const [mode, setMode] = useState<'plan' | 'build'>('build');
  const [commands, setCommands] = useState<CommandDefinition[]>([]);
  const [permission, setPermission] = useState<PermissionRequest | null>(null);
  const [question, setQuestion] = useState<QuestionRequest | null>(null);
  const [modal, setModal] = useState<ModalName>(null);
  const [settingsSection, setSettingsSection] = useState('account');
  const [toast, setToast] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const running = useClientRunState();

  const activeProjectId = active?.projectId ?? draft?.projectId ?? null;
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
  const activeRunning = Boolean(active?.id && running.has(active.id));
  const activeComposerMode: ComposerMode = cognitive.orchestratorEnabled ? 'orchestrate' : mode;

  const showToast = useCallback((message: unknown) => {
    setToast(message instanceof Error ? message.message : String(message ?? ''));
  }, []);

  const refreshLists = useCallback(async () => {
    const [nextProjects, nextSessions] = await Promise.all([
      window.cuppet.projects.list(),
      window.cuppet.sessions.list(),
    ]);
    setProjects(nextProjects);
    setSessions(nextSessions);
    hydrateClientRunState(nextSessions);
    return { nextProjects, nextSessions };
  }, []);

  const openSession = useCallback(async (sessionId: string) => {
    const [session, modeState] = await Promise.all([
      window.cuppet.sessions.get(sessionId),
      window.cuppet.cognitive.modeGet(sessionId),
    ]);
    setActive(session);
    setDraft(null);
    setMode(modeState.mode === 'plan' ? 'plan' : 'build');
    localStorage.setItem(LAST_SESSION_KEY, session.id);
    if (session.projectId) void window.cuppet.projects.open(session.projectId).catch(() => undefined);
    hydrateClientRunSession(session);
  }, []);

  const startDraft = useCallback((projectId: string | null = null) => {
    setActive(null);
    setDraft({ projectId, mode: 'build' });
    setMode('build');
  }, []);

  const ensureActiveSession = useCallback(async () => {
    if (active) return active;
    const projectId = draft?.projectId ?? null;
    const created = await window.cuppet.sessions.create(projectId);
    if (draft?.mode === 'plan') await window.cuppet.cognitive.modeSet(created.id, 'plan');
    const session = { ...created, messages: created.messages ?? [] };
    setSessions((current) => upsertSession(current, session));
    setActive(session);
    setDraft(null);
    setMode(draft?.mode ?? 'build');
    hydrateClientRunSession(session);
    localStorage.setItem(LAST_SESSION_KEY, session.id);
    return session;
  }, [active, draft]);

  const refreshActive = useCallback(async (sessionId?: string | null) => {
    const id = sessionId ?? active?.id;
    if (!id) return;
    try {
      const session = await window.cuppet.sessions.get(id);
      setSessions((current) => upsertSession(current, session));
      setActive((current) => current?.id === id ? session : current);
      hydrateClientRunSession(session);
    } catch {
      // Session may have been archived/deleted during the refresh.
    }
  }, [active?.id]);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const [health, nextProvider, nextProjects, nextSessions, nextCognitive, nextCommands] = await Promise.all([
          window.cuppet.health(),
          window.cuppet.settings.get(),
          window.cuppet.projects.list(),
          window.cuppet.sessions.list(),
          window.cuppet.cognitive.status(),
          window.cuppet.commands.list(),
        ]);
        if (disposed) return;
        if (!health?.ok) showToast('Runtime unavailable');
        setProvider(nextProvider);
        setProjects(nextProjects);
        setSessions(nextSessions);
        setCognitive(nextCognitive);
        setCommands(nextCommands);
        hydrateClientRunState(nextSessions);
        const saved = localStorage.getItem(LAST_SESSION_KEY);
        const initial = (saved && nextSessions.find((session) => session.id === saved)) || nextSessions[0];
        if (initial) await openSession(initial.id);
        else startDraft(null);
        const [pendingPermission] = await window.cuppet.permissions.list().catch(() => []);
        const [pendingQuestion] = await window.cuppet.questions.list().catch(() => []);
        if (!disposed) {
          if (pendingPermission) setPermission(pendingPermission);
          if (pendingQuestion) setQuestion(pendingQuestion);
        }
      } catch (error) {
        if (!disposed) showToast(error);
      } finally {
        if (!disposed) setLoading(false);
      }
    })();
    return () => { disposed = true; };
  }, [openSession, showToast, startDraft]);

  useEffect(() => window.cuppet.onEvent((event) => {
    void handleEvent(event);
  }), [active?.id, refreshActive]);

  const handleEvent = useCallback(async (event: RuntimeEvent) => {
    if (!event?.type) return;
    const sessionId = String(event.sessionId ?? event.message?.sessionId ?? '');

    if (event.type === 'run.finished' && sessionId) {
      void refreshActive(sessionId);
    }
    if (event.type === 'pe3.routed' && event.targetSessionId) {
      const target = String(event.targetSessionId);
      if (active?.id === event.sourceSessionId) void openSession(target).catch(showToast);
    }
    if (event.type === 'runtime.error') showToast(event.message || 'Runtime error');
    if (event.type === 'cognitive.updated' && event.cognitive) setCognitive(event.cognitive);
    if (event.type === 'context.compiled' && event.tst) setCognitive((current) => ({ ...current, tst: event.tst }));
    if (event.project) setProjects((current) => upsertProject(current, event.project));
    if (event.type === 'project.removed' && event.projectId) {
      setProjects((current) => current.filter((project) => project.id !== event.projectId));
      void refreshLists();
    }
    if (event.session) setSessions((current) => upsertSession(current, event.session));

    if (event.message && active?.id === event.message.sessionId) {
      setActive((current) => current ? { ...current, messages: upsertMessage(current.messages ?? [], event.message) } : current);
    }
    if (event.type === 'message.delta' && active?.id === sessionId && event.messageId) {
      setActive((current) => {
        if (!current) return current;
        const messages = [...(current.messages ?? [])];
        const index = messages.findIndex((message) => message.id === event.messageId);
        if (index >= 0) messages[index] = { ...messages[index], content: String(event.content ?? ''), status: 'streaming' };
        return { ...current, messages };
      });
    }
    if ((event.type === 'message.created' || event.type === 'message.completed') && sessionId) void refreshActive(sessionId);
    if (['session.archived', 'session.deleted', 'session.restored'].includes(event.type)) void refreshLists();

    if (event.type === 'permission.requested' && event.request) setPermission(event.request);
    if (event.type === 'permission.resolved' && permission?.id === event.requestId) setPermission(null);
    if (event.type === 'question.requested' && event.request) setQuestion(event.request);
    if (event.type === 'question.resolved' && question?.id === event.requestId) setQuestion(null);

    if (sessionId && (event.type === 'tool.started' || event.type === 'tool.finished')) {
      void refreshActive(sessionId);
    }
  }, [active?.id, openSession, permission?.id, question?.id, refreshActive, refreshLists, showToast]);

  const selectProject = useCallback(async (projectId: string) => {
    const project = projects.find((item) => item.id === projectId);
    if (!project) return;
    await window.cuppet.projects.open(projectId).catch(() => undefined);
    const latest = sessions
      .filter((session) => session.projectId === projectId)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
    if (latest) await openSession(latest.id);
    else startDraft(projectId);
  }, [openSession, projects, sessions, startDraft]);

  const executeCommand = useCallback(async (raw: string, definition?: CommandDefinition) => {
    const def = definition ?? commandForRaw(commands, raw);
    let sessionId = active?.id ?? null;
    if (def?.requiresSession && !sessionId) sessionId = (await ensureActiveSession()).id;
    const result = await window.cuppet.commands.execute(sessionId, raw);
    if ((result.id === 'plan' || result.id === 'cuppet.plan.agent') && result.result && typeof result.result === 'object') {
      const nextMode = (result.result as { mode?: string }).mode;
      if (nextMode === 'plan' || nextMode === 'build') setMode(nextMode);
    }
    return result;
  }, [active?.id, commands, ensureActiveSession]);

  const send = useCallback(async (text: string, deliveryMode: DeliveryMode = 'queue', attachments: Attachment[] = []) => {
    const trimmed = text.trim();
    const value = trimmed || (attachments.length ? `Attached: ${attachments.map((item) => item.name).join(', ')}` : '');
    if (!value) return { clear: false };
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

      const session = await ensureActiveSession();
      const project = projects.find((item) => item.id === session.projectId);
      if (project?.missing) throw new Error(`Relocate ${project.name} before continuing.`);

      if (running.has(session.id)) {
        if (deliveryMode === 'steer' && !attachments.length) {
          await window.cuppet.commands.execute(session.id, { id: 'cuppet.steer.interrupt', input: { text: value.slice(0, 8192) } });
        } else {
          await window.cuppet.sessions.send(session.id, value, attachments);
        }
        return { clear: true };
      }

      const result = await window.cuppet.sessions.send(session.id, value, attachments);
      const target = String(result?.sessionId || session.id);
      markClientRunStarted(target);
      if (target !== session.id) await openSession(target);
      return { clear: true };
    } catch (error) {
      if (String(error instanceof Error ? error.message : error).includes('Settings > General > Integrations')) {
        setSettingsSection('general');
        setModal('settings');
      }
      showToast(error);
      return { clear: false };
    }
  }, [commands, ensureActiveSession, executeCommand, openSession, projects, provider, running, showToast]);

  const stop = useCallback(async () => {
    if (!active?.id || !running.has(active.id)) return;
    try { await window.cuppet.sessions.stop(active.id); }
    catch (error) { showToast(error); }
  }, [active?.id, running, showToast]);

  const removeProject = useCallback(async (project: Project) => {
    if (!window.confirm(`Remove ${project.name} from Cuppet? Files stay on disk and chats remain local.`)) return;
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

  const renameProject = useCallback(async (project: Project) => {
    const value = window.prompt('Rename project', project.name)?.trim();
    if (!value || value === project.name) return;
    try { await window.cuppet.projects.rename(project.id, value); await refreshLists(); }
    catch (error) { showToast(error); }
  }, [refreshLists, showToast]);

  const renameSession = useCallback(async (session: Session) => {
    const value = window.prompt('Rename chat', session.title || 'New chat')?.trim();
    if (!value || value === session.title) return;
    try { await window.cuppet.sessions.rename(session.id, value); await refreshLists(); if (active?.id === session.id) await refreshActive(session.id); }
    catch (error) { showToast(error); }
  }, [active?.id, refreshActive, refreshLists, showToast]);

  const archiveSession = useCallback(async (session: Session) => {
    if (!window.confirm(`Archive “${session.title || 'New chat'}”?`)) return;
    try {
      await window.cuppet.sessions.archive(session.id);
      const { nextSessions } = await refreshLists();
      if (active?.id === session.id) {
        const next = nextSessions.find((item) => item.id !== session.id);
        if (next) await openSession(next.id); else startDraft(session.projectId ?? null);
      }
    } catch (error) { showToast(error); }
  }, [active?.id, openSession, refreshLists, showToast, startDraft]);

  const deleteSession = useCallback(async (session: Session) => {
    if (!window.confirm(`Delete “${session.title || 'New chat'}” permanently?`)) return;
    try {
      await window.cuppet.sessions.delete(session.id);
      const { nextSessions } = await refreshLists();
      if (active?.id === session.id) {
        const next = nextSessions.find((item) => item.id !== session.id);
        if (next) await openSession(next.id); else startDraft(session.projectId ?? null);
      }
    } catch (error) { showToast(error); }
  }, [active?.id, openSession, refreshLists, showToast, startDraft]);

  const changeMode = useCallback(async (next: ComposerMode) => {
    const sessionMode: 'plan' | 'build' = next === 'plan' ? 'plan' : 'build';
    const orchestratorEnabled = next === 'orchestrate';
    try {
      if (active) await window.cuppet.cognitive.modeSet(active.id, sessionMode);
      else setDraft((current) => current ? { ...current, mode: sessionMode } : current);
      setMode(sessionMode);
      await window.cuppet.cognitive.orchestratorSet(orchestratorEnabled);
      setCognitive((current) => ({ ...current, orchestratorEnabled }));
    } catch (error) { showToast(error); }
  }, [active, showToast]);

  const resolvePermission = useCallback(async (reply: 'once' | 'always' | 'reject', enableAuto = false) => {
    if (!permission) return;
    try {
      if (enableAuto && permission.autoEligible && permission.sessionId) await window.cuppet.permissions.autoSet(permission.sessionId, true);
      await window.cuppet.permissions.reply(permission.id, enableAuto ? 'once' : reply);
      const [next] = await window.cuppet.permissions.list().catch(() => []);
      setPermission(next ?? null);
    } catch (error) { showToast(error); }
  }, [permission, showToast]);

  const answerQuestion = useCallback(async (answers: string[][] | null) => {
    if (!question) return;
    try {
      if (answers) await window.cuppet.questions.reply(question.id, answers);
      else await window.cuppet.questions.reject(question.id);
      const [next] = await window.cuppet.questions.list().catch(() => []);
      setQuestion(next ?? null);
    } catch (error) { showToast(error); }
  }, [question, showToast]);

  const generalSessions = useMemo(() => sessions.filter((session) => !session.projectId && !session.archivedAt), [sessions]);

  if (loading) return <div className="react-boot"><div className="react-boot-brand"><img src={CUPPET_LOGO_URL} alt="" aria-hidden="true" /><span>Starting Cuppet…</span></div></div>;

  return (
    <div className="app-shell react-app">
      <Sidebar
        projects={projects}
        sessions={sessions.filter((session) => !session.archivedAt)}
        generalSessions={generalSessions}
        activeSessionId={active?.id ?? null}
        selectedProjectId={activeProjectId}
        onNewChat={() => setModal('new-chat')}
        onNewProjectChat={(projectId) => startDraft(projectId)}
        onSearch={() => setModal('search')}
        onRemote={() => setModal('remote')}
        onSettings={() => { setSettingsSection('account'); setModal('settings'); }}
        onAddProject={() => setModal('add-project')}
        onProject={selectProject}
        onSession={openSession}
        onRenameProject={renameProject}
        onRemoveProject={removeProject}
        onRenameSession={renameSession}
        onArchiveSession={archiveSession}
        onDeleteSession={deleteSession}
      />
      <ChatPane
        session={active}
        draft={draft}
        project={activeProject}
        mode={mode}
        activeMode={activeComposerMode}
        running={activeRunning}
        commands={commands}
        activity={[]}
        onSend={send}
        onStop={stop}
        onModeChange={changeMode}
      />

      {modal === 'new-chat' && <NewChatModal projects={projects} selectedProjectId={activeProjectId} onClose={() => setModal(null)} onStart={(projectId) => { startDraft(projectId); setModal(null); }} />}
      {modal === 'add-project' && <AddProjectModal onClose={() => setModal(null)} onAdded={async (project) => { await refreshLists(); startDraft(project.id); setModal(null); }} onError={showToast} />}
      {modal === 'search' && <SearchModal projects={projects} onClose={() => setModal(null)} onOpen={async (id) => { await openSession(id); setModal(null); }} onChanged={refreshLists} onError={showToast} />}
      {modal === 'remote' && <RemoteModal onClose={() => setModal(null)} onError={showToast} />}
      {modal === 'settings' && <SettingsModal provider={provider} initialSection={settingsSection} onClose={() => setModal(null)} onSaved={(value) => setProvider(value)} onOpenRemote={() => setModal('remote')} onError={showToast} />}
      {permission && <PermissionModal request={permission} onResolve={resolvePermission} />}
      {question && <QuestionModal request={question} onAnswer={answerQuestion} />}
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

function upsertSession(values: Session[], value: Session) {
  const next = [...values];
  const index = next.findIndex((item) => item.id === value.id);
  if (index >= 0) next[index] = { ...next[index], ...value };
  else next.unshift(value);
  return next.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

function upsertMessage(values: Message[], value: Message) {
  const next = [...values];
  const index = next.findIndex((item) => item.id === value.id);
  if (index >= 0) next[index] = value;
  else next.push(value);
  return next.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
}
