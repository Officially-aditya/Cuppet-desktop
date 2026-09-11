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
import { ChatPane, type ActivityEntry, type DeliveryMode } from './ChatPane';
import { NewChatModal } from './NewChatModal';
import { AddProjectModal } from './AddProjectModal';
import { SearchModal } from './SearchModal';
import { RemoteModal } from './RemoteModal';
import { SettingsModal } from './SettingsModal';
import { PermissionModal } from './PermissionModal';
import { QuestionModal } from './QuestionModal';
import { Toast } from './Toast';
import { CUPPET_LOGO_URL } from './brand';

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
  const [running, setRunning] = useState<Set<string>>(() => new Set());
  const [commands, setCommands] = useState<CommandDefinition[]>([]);
  const [activities, setActivities] = useState<Record<string, ActivityEntry[]>>({});
  const [permission, setPermission] = useState<PermissionRequest | null>(null);
  const [question, setQuestion] = useState<QuestionRequest | null>(null);
  const [modal, setModal] = useState<ModalName>(null);
  const [settingsSection, setSettingsSection] = useState('account');
  const [toast, setToast] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const activeProjectId = active?.projectId ?? draft?.projectId ?? null;
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
  const activeRunning = Boolean(active?.id && running.has(active.id));

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
    setRunning((current) => {
      const next = new Set(current);
      if (session.messages.some((message) => message.status === 'streaming') || session.lastStatus === 'streaming') next.add(session.id);
      else next.delete(session.id);
      return next;
    });
    if (session.toolExecutions?.length) {
      setActivities((current) => ({ ...current, [session.id]: hydrateToolActivity(session) }));
    }
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
      setActivities((current) => ({ ...current, [id]: hydrateToolActivity(session) }));
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
        setRunning(new Set(nextSessions.filter((session) => session.lastStatus === 'streaming').map((session) => session.id)));
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

    if (event.type === 'run.started' && sessionId) {
      setRunning((current) => new Set(current).add(sessionId));
    }
    if (event.type === 'run.finished' && sessionId) {
      setRunning((current) => { const next = new Set(current); next.delete(sessionId); return next; });
      void refreshActive(sessionId);
    }
    if (event.type === 'pe3.routed' && event.targetSessionId) {
      const target = String(event.targetSessionId);
      setRunning((current) => {
        const next = new Set(current);
        if (event.sourceSessionId) next.delete(String(event.sourceSessionId));
        next.add(target);
        return next;
      });
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
    } else if (sessionId) {
      setActivities((current) => reduceActivity(current, sessionId, event));
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
      setRunning((current) => new Set(current).add(target));
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

  const changeMode = useCallback(async () => {
    const next = mode === 'plan' ? 'build' : 'plan';
    try {
      if (active) await window.cuppet.cognitive.modeSet(active.id, next);
      else setDraft((current) => current ? { ...current, mode: next } : current);
      setMode(next);
    } catch (error) { showToast(error); }
  }, [active, mode, showToast]);

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
        running={activeRunning}
        commands={commands}
        activity={active?.id ? activities[active.id] ?? [] : []}
        onSend={send}
        onStop={stop}
        onToggleMode={changeMode}
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

function hydrateToolActivity(session: Session): ActivityEntry[] {
  return (session.toolExecutions ?? []).slice(-20).map((execution) => {
    const status = execution.status === 'running' ? 'running' : execution.status === 'complete' ? 'complete' : 'error';
    return {
      id: execution.id,
      kind: 'tool',
      status,
      label: toolActivityLabel(execution.toolName, execution.argumentsJson, status),
      details: execution.output,
    };
  });
}

function toolActivityLabel(toolName = '', argumentsJson = '{}', status: string) {
  const args = parseToolArguments(argumentsJson);
  const failed = status === 'error';
  const complete = status === 'complete';
  const phrase = (active: string, done: string, error: string) => failed ? error : complete ? done : active;
  const targets = toolTargets(toolName, args);
  const one = targets.length === 1 ? targetName(targets[0]) : '';
  const many = targets.length > 1 ? `${targets.length} files` : '';
  const target = one || many;

  if (toolName === 'tst_read') return target
    ? phrase(`Reading ${target}…`, `Read ${target}`, `Couldn’t read ${target}`)
    : phrase('Reading…', 'Read files', 'Couldn’t read files');
  if (toolName === 'tst_explore') {
    const focus = toolExploreFocus(args);
    return focus
      ? phrase(`Exploring ${focus}…`, `Explored ${focus}`, `Couldn’t explore ${focus}`)
      : phrase('Exploring…', 'Explored', 'Couldn’t explore');
  }
  if (toolName === 'tst_edit_batch') {
    if (String(args.action ?? '') === 'apply' && !target) return phrase('Applying edits…', 'Applied edits', 'Couldn’t apply edits');
    return target
      ? phrase(`Editing ${target}…`, `Edited ${target}`, `Couldn’t edit ${target}`)
      : phrase('Editing files…', 'Edited files', 'Couldn’t edit files');
  }
  if (toolName === 'workspace_edit') return target
    ? phrase(`Editing ${target}…`, `Edited ${target}`, `Couldn’t edit ${target}`)
    : phrase('Editing…', 'Edited file', 'Couldn’t edit file');
  if (toolName === 'workspace_write') return target
    ? phrase(`Writing ${target}…`, `Wrote ${target}`, `Couldn’t write ${target}`)
    : phrase('Writing…', 'Wrote file', 'Couldn’t write file');
  if (toolName === 'tst_validate') return target
    ? phrase(`Validating ${target}…`, `Validated ${target}`, `Validation failed for ${target}`)
    : phrase('Validating…', 'Validated', 'Validation failed');
  if (toolName === 'cuppet_memory_search') return phrase('Searching memory…', 'Searched memory', 'Couldn’t search memory');
  if (toolName === 'cuppet_plan') return phrase('Reviewing plan…', 'Reviewed plan', 'Couldn’t review plan');
  if (toolName === 'bash') return phrase('Running command…', 'Ran command', 'Command failed');
  if (toolName === 'question') return phrase('Waiting for input…', 'Received input', 'Input request failed');
  return phrase('Working…', 'Completed', 'Failed');
}

function toolTargets(toolName: string, args: Record<string, unknown>) {
  const values: string[] = [];
  const add = (value: unknown) => {
    if (typeof value !== 'string') return;
    const path = value.trim();
    if (path && !values.includes(path)) values.push(path);
  };

  if (toolName === 'tst_read') {
    add(args.path);
    for (const item of arrayRecords(args.reads)) add(item.path);
    for (const item of arrayRecords(args.targets)) add(item.path);
  } else if (toolName === 'tst_edit_batch') {
    for (const item of arrayRecords(args.operations)) {
      add(item.path);
      if (item.target && typeof item.target === 'object' && !Array.isArray(item.target)) add((item.target as Record<string, unknown>).path);
    }
  } else if (toolName === 'tst_validate') {
    for (const value of Array.isArray(args.paths) ? args.paths : []) add(value);
  } else if (toolName === 'workspace_edit' || toolName === 'workspace_write') {
    add(args.path);
  }
  return values.slice(0, 64);
}

function toolExploreFocus(args: Record<string, unknown>) {
  const prefix = typeof args.prefix === 'string' ? args.prefix.trim() : '';
  if (prefix) return targetName(prefix);
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (query) return compactActivityText(query);
  return '';
}

function parseToolArguments(value: string) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function arrayRecords(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)));
}

function targetName(path: string) {
  const normalized = path.replaceAll('\\', '/').replace(/\/+$/, '');
  const name = normalized.split('/').filter(Boolean).at(-1) || normalized;
  return compactActivityText(name);
}

function compactActivityText(value: string) {
  const text = value.replace(/[\r\n\t]+/g, ' ').trim();
  return text.length > 72 ? `${text.slice(0, 69)}…` : text;
}

function reduceActivity(current: Record<string, ActivityEntry[]>, sessionId: string, event: RuntimeEvent) {
  const list = [...(current[sessionId] ?? [])];
  const id = String(event.executionId ?? event.queueId ?? event.validation?.id ?? `${event.type}-${Date.now()}`);
  let patch: ActivityEntry | null = null;
  if (event.type === 'queue.queued') patch = { id, kind: 'queue', status: 'queued', label: `Queued message${event.position ? ` #${event.position}` : ''}` };
  if (event.type === 'queue.started') patch = { id, kind: 'queue', status: 'running', label: 'Starting queued message' };
  if (event.type === 'queue.dispatched') patch = { id, kind: 'queue', status: 'complete', label: 'Queued message started' };
  if (event.type === 'queue.failed') patch = { id, kind: 'queue', status: 'error', label: 'Queued message failed', details: event.message };
  if (event.type === 'validation.completed') patch = { id, kind: 'validation', status: event.validation?.success === false ? 'error' : 'complete', label: event.validation?.success === false ? 'Validation failed' : 'Validation passed', details: JSON.stringify(event.validation ?? {}, null, 2) };
  if (!patch) return current;
  const index = list.findIndex((item) => item.id === patch!.id);
  if (index >= 0) list[index] = { ...list[index], ...patch };
  else list.push(patch);
  return { ...current, [sessionId]: list.slice(-30) };
}
