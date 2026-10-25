import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, Notification, shell } from 'electron';
import { realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RuntimeClient } from './runtime-client.mjs';
import { ProviderSettingsStore } from './provider-settings.mjs';
import { providerPreset } from './provider-presets.mjs';
import { ProjectTerminalManager } from './project-terminal-manager.mjs';
import { executeCommand, listCommands, parseSlashCommand } from '../runtime/commands.mjs';
import { isLocalCliProvider } from '../runtime/local-cli-descriptors.mjs';
import { SandboxManager } from '../runtime/sandbox/sandbox-manager.mjs';
import { createLinkPreviewLoader } from './link-preview.mjs';
import { resolveProjectFileDetails, resolveProjectFilePath } from './project-file-path.mjs';
import { decideProjectFileOpen } from './open-file-policy.mjs';
import { createApprovalAttention } from './approval-attention.mjs';
import { createWindowAppearance } from './window-appearance.mjs';
import { createIpcRegistrar } from './ipc-boundary.mjs';
import { validateAttachments, validateCommandInput } from './command-input.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const APP_ICON = join(here, '..', '..', 'build', 'icon.png');
const APP_ICON_MACOS = join(here, '..', '..', 'build', 'icon-macos.png');
let runtime;
let settings;
let mainWindow;
let runtimeDataDir;
let terminals;
let windowAppearance;
const attention = createApprovalAttention({
  getWindow: () => mainWindow,
  setBadgeCount: (count) => app.setBadgeCount(count),
  notify: ({ title, body, onClick }) => {
    if (!Notification.isSupported()) return null;
    const notification = new Notification({ title, body });
    notification.on('click', onClick);
    notification.show();
    return notification;
  },
});
const loadLinkPreview = createLinkPreviewLoader();

async function bootstrap() {
  const userData = app.getPath('userData');
  windowAppearance = await createWindowAppearance({ nativeTheme, path: join(userData, 'appearance.json'), getWindow: () => mainWindow, isMac: process.platform === 'darwin' });
  runtimeDataDir = join(userData, 'runtime');
  settings = new ProviderSettingsStore(join(userData, 'provider-settings.json'));
  await settings.load();
  runtime = new RuntimeClient({
    entry: join(here, '..', 'runtime', 'main.mjs'),
    dataDir: runtimeDataDir,
    environment: { CUPPET_USER_DATA_DIR: userData },
  });
  const syncProviderConfig = () => runtime.request('provider.config.sync', { provider: settings.runtimeValue() });
  runtime.on('event', (event) => {
    if (event?.type === 'provider.authentication.url' && event.providerID === 'antigravity') {
      const url = new URL(event.url);
      if (url.protocol === 'https:' && url.hostname === 'accounts.google.com') void openExternal(url.toString()).catch(console.error);
      return;
    }
    attention.handle(event);
    mainWindow?.webContents.send('cuppet:event', event);
  });
  runtime.on('exit', (info) => mainWindow?.webContents.send('cuppet:event', { type: 'runtime.error', message: `Runtime exited unexpectedly${info?.code !== null ? ` (code ${info.code})` : ''}` }));
  runtime.on('recovered', () => { void syncProviderConfig().then(() => runtime.request('remote.resume')).catch(() => undefined); });
  await runtime.start();
  await syncProviderConfig().catch(() => undefined);
  void runtime.request('remote.resume').catch(() => undefined);
  terminals = new ProjectTerminalManager({ request: (method, params) => runtime.request(method, params) });
  registerIpc();
  if (process.platform === 'darwin' && app.dock) app.dock.setIcon(APP_ICON_MACOS);
  createWindow();
  for (const [method, type] of [['permission.list', 'permission.requested'], ['question.list', 'question.requested']]) {
    for (const request of await runtime.request(method).catch(() => [])) attention.handle({ type, request });
  }
}

function registerIpc() {
  const handle = createIpcRegistrar({ ipcMain, getWindow: () => mainWindow, rendererUrl: new URL('../../dist-renderer/index.html', import.meta.url).href });
  const request = (method, params) => runtime.request(method, params);
  handle('health', () => request('health'));
  handle('usage.summary', () => request('usage.summary'));
  handle('integrations.browserControl.status', () => request('integration.browser.status'));
  handle('integrations.browserControl.connect', () => request('integration.browser.connect'));
  handle('integrations.browserControl.disconnect', () => request('integration.browser.disconnect'));
  handle('cognitive.status', () => request('cognitive.status'));
  handle('cognitive.modeGet', (_event, sessionId) => request('session.mode.get', { sessionId }));
  handle('cognitive.modeSet', (_event, sessionId, mode) => request('session.mode.set', { sessionId, mode }));
  handle('permissions.autoGet', (_event, sessionId) => request('session.auto.get', { sessionId }));
  handle('permissions.autoSet', (_event, sessionId, enabled) => request('session.auto.set', { sessionId, enabled: enabled === 'full' ? 'full' : Boolean(enabled) }));
  handle('permissions.list', (_event, sessionId) => request('permission.list', { sessionId: sessionId ?? null }));
  handle('permissions.reply', (_event, requestId, reply) => request('permission.reply', { requestId, reply: validatePermissionReply(reply) }));
  handle('questions.list', (_event, sessionId) => request('question.list', { sessionId: sessionId ?? null }));
  handle('questions.reply', (_event, requestId, answers) => request('question.reply', { requestId: boundedId(requestId), answers: validateQuestionAnswers(answers) }));
  handle('questions.reject', (_event, requestId) => request('question.reject', { requestId: boundedId(requestId) }));
  handle('cognitive.orchestratorSet', (_event, enabled) => request('orchestrator.set', { enabled: Boolean(enabled) }));
  handle('cognitive.backgroundStatus', () => request('background.status'));
  handle('cognitive.backgroundPause', () => request('background.pause'));
  handle('cognitive.backgroundResume', () => request('background.resume'));
  handle('cognitive.backgroundFlush', (_event, sessionId) => request('background.flush', { sessionId }));
  handle('cognitive.planGet', (_event, sessionId, requestValue) => request('plan.get', { sessionId, request: requestValue }));
  handle('cognitive.memoryQuery', (_event, sessionId, query) => request('memory.query', { sessionId, query }));
  handle('cognitive.memoryGraph', (_event, sessionId) => request('memory.graph', { sessionId: boundedId(sessionId) }));
  handle('pe3.status', (_event, sessionId) => request('pe3.status', { sessionId }));
  handle('pe3.observePaths', (_event, sessionId, paths) => request('pe3.observe-paths', { sessionId, paths: validatePaths(paths) }));
  handle('pe3.workspaceMutation', (_event, sessionId, paths) => request('pe3.workspace-mutation', { sessionId, paths: validatePaths(paths) }));

  handle('remote.status', () => request('remote.status'));
  handle('remote.start', (_event, value) => request('remote.start', { ...validateRemoteStart(value), provider: settings.runtimeValue() }));
  handle('remote.stop', () => request('remote.stop'));
  handle('remote.invite', (_event, role) => request('remote.invite', { role: role === 'viewer' ? 'viewer' : 'trusted' }));
  handle('remote.devices', () => request('remote.devices'));
  handle('remote.revoke', (_event, deviceId) => request('remote.revoke', { deviceId: typeof deviceId === 'string' ? deviceId.slice(0, 128) : '' }));

  handle('commands.list', () => listCommands());
  handle('commands.execute', async (_event, sessionId, value) => executeDesktopCommand(request, sessionId, value));

  handle('sessions.list', (_event, projectId) => request('session.list', projectId === undefined ? {} : { projectId }));
  handle('sessions.deleted', () => request('session.deleted.list'));
  handle('sessions.create', (_event, projectId) => request('session.create', { projectId: projectId ?? null }));
  handle('sessions.get', (_event, sessionId, options) => request('session.get', { sessionId, limit: options?.limit, beforeSequence: options?.beforeSequence }));
  handle('sessions.attachment', (_event, sessionId, messageId, index) => request('session.attachment', { sessionId, messageId, index }));
  handle('sessions.editedFiles', (_event, sessionId) => request('session.edited-files', { sessionId: boundedId(sessionId) }));
  handle('sessions.search', (_event, query, options) => request('session.search', { query: typeof query === 'string' ? query.slice(0, 512) : '', limit: clampLimit(options?.limit), includeArchived: options?.includeArchived === true }));
  handle('sessions.rename', (_event, sessionId, title) => request('session.rename', { sessionId: boundedId(sessionId), title: typeof title === 'string' ? title.trim().slice(0, 160) : '' }));
  handle('sessions.archive', (_event, sessionId) => request('session.archive', { sessionId: boundedId(sessionId) }));
  handle('sessions.restore', (_event, sessionId) => request('session.restore', { sessionId: boundedId(sessionId) }));
  handle('sessions.delete', (_event, sessionId) => request('session.delete', { sessionId: boundedId(sessionId) }));
  handle('sessions.send', async (_event, sessionId, text, attachments) => {
    const parsed = parseSlashCommand(text);
    if (parsed.kind === 'unknown') throw new Error(`Unknown Cuppet command: /${parsed.name}`);
    if (parsed.kind === 'command') return executeDesktopCommand(request, sessionId, parsed);
    return request('session.send', { sessionId, text, attachments: validateAttachments(attachments), provider: settings.runtimeValue() });
  });
  handle('sessions.stop', (_event, sessionId) => request('session.stop', { sessionId }));
  handle('sessions.undoStatus', (_event, sessionId) => request('session.undo.status', { sessionId: boundedId(sessionId) }));
  handle('sessions.undo', (_event, sessionId) => request('session.undo', { sessionId: boundedId(sessionId) }));
  handle('sessions.queueList', (_event, sessionId) => request('session.queue.list', { sessionId: boundedId(sessionId) }));
  handle('sessions.queueCancel', (_event, queueId, sessionId) => request('session.queue.cancel', { queueId: boundedId(queueId), sessionId: boundedId(sessionId) }));

  handle('projects.list', () => request('project.list'));
  handle('projects.get', (_event, projectId) => request('project.get', { projectId }));
  handle('projects.open', (_event, projectId) => request('project.open', { projectId }));
  handle('projects.rename', (_event, projectId, name) => request('project.rename', { projectId: boundedId(projectId), name: typeof name === 'string' ? name.trim().slice(0, 120) : '' }));
  handle('projects.addLocal', (_event, value) => request('project.add-local', validateProjectPayload(value)));
  handle('projects.cloneUrl', (_event, value) => request('project.clone-url', validateClonePayload(value, true)));
  handle('projects.githubList', (_event, query) => request('project.github-list', { query: typeof query === 'string' ? query.slice(0, 120) : '' }));
  handle('projects.githubClone', (_event, value) => request('project.github-clone', validateClonePayload(value, false)));
  handle('projects.relocate', (_event, projectId, path) => request('project.relocate', { projectId, path }));
  handle('projects.checkoutBranch', (_event, projectId, branch) => request('project.checkout-branch', { projectId: boundedId(projectId), branch: typeof branch === 'string' ? branch.trim() : '' }));
  handle('projects.remove', (_event, projectId) => request('project.remove', { projectId }));

  handle('terminal.start', (event, projectId, options) => terminals.start(event.sender, projectId, options));
  handle('terminal.write', (event, sessionId, input) => terminals.write(event.sender, sessionId, input));
  handle('terminal.resize', (event, sessionId, cols, rows) => terminals.resize(event.sender, sessionId, cols, rows));
  handle('terminal.interrupt', (event, sessionId) => terminals.interrupt(event.sender, sessionId));
  handle('terminal.stop', (event, sessionId) => terminals.stop(event.sender, sessionId));

  handle('native.setAppearance', (_event, preference) => windowAppearance.set(preference));
  handle('native.chooseFolder', (_event, options) => chooseFolder(options));
  handle('native.openProjectFile', (_event, projectId, path) => openProjectFile(request, projectId, path));
  handle('native.projectFileEditor', (_event, projectId, path) => projectFileEditor(request, projectId, path));
  handle('native.linkPreview', (_event, url) => loadLinkPreview(url));
  handle('native.openExternal', (_event, url) => openExternal(url));
  handle('native.copyText', (_event, value) => {
    const text = typeof value === 'string' ? value.slice(0, 2_000_000) : '';
    clipboard.writeText(text);
    return { copied: true };
  });
  handle('native.minimizeWindow', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.minimize();
  });
  handle('native.toggleMaximizeWindow', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    if (win.isMaximized()) {
      win.unmaximize();
      return false;
    }
    win.maximize();
    return true;
  });
  handle('native.closeWindow', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.close();
  });
  handle('native.isWindowMaximized', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win?.isMaximized() ?? false;
  });

  handle('cliAgents.status', (_event, providerID) => request('provider.local.status', { providerID: validateCliProviderID(providerID) }));
  handle('cliAgents.connect', (_event, providerID) => request('provider.local.connect', { providerID: validateCliProviderID(providerID) }));
  const sandbox = new SandboxManager();
  handle('sandbox.status', () => sandbox.getCapabilities());
  handle('settings.get', () => settings.rendererValue());
  handle('settings.models', async (_event, value) => {
    const catalog = await request('provider.models', {
      provider: settings.runtimeValue(),
      model: value && typeof value === 'object' && !Array.isArray(value) && typeof value.model === 'string'
        ? value.model.trim().slice(0, 1000)
        : '',
      sessionId: value && typeof value === 'object' && !Array.isArray(value) && typeof value.sessionId === 'string'
        ? value.sessionId.trim().slice(0, 256)
        : '',
      projectRoot: value && typeof value === 'object' && !Array.isArray(value) && typeof value.projectRoot === 'string'
        ? value.projectRoot.trim().slice(0, 1000)
        : '',
      force: Boolean(value?.force),
      refresh: Boolean(value?.refresh),
    });
    if (await settings.reconcileModelCapabilities(catalog)) {
      await request('provider.config.sync', { provider: settings.runtimeValue() }).catch(() => undefined);
    }
    return catalog;
  });
  handle('settings.save', async (_event, value) => {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const requestedProviderID = typeof source.providerID === 'string' && source.providerID.trim()
      ? source.providerID.trim()
      : settings.rendererValue().primary?.providerID || settings.rendererValue().providerID || '';
    const preset = providerPreset(requestedProviderID);
    const explicitModel = typeof source.model === 'string' && source.model.trim();
    const resetToProviderDefault = source.resolveDefault === true && !explicitModel && preset?.authType === 'local-cli';
    const defaultModel = resetToProviderDefault ? String(preset.model || 'cli-default').trim() : '';
    const saveSource = resetToProviderDefault
      ? { ...source, model: defaultModel, backgroundModel: defaultModel, secondaryAuto: true }
      : source;
    const result = await settings.save(saveSource);
    await request('provider.config.sync', {
      provider: settings.runtimeValue(),
      sessionId: typeof source.sessionId === 'string' ? source.sessionId.trim().slice(0, 256) : '',
    }).catch(() => undefined);
    return result;
  });
}

async function executeDesktopCommand(request, sessionId, value) {
  const structured = value && typeof value === 'object' && !Array.isArray(value) && typeof value.id === 'string' ? value : null;
  const parsed = structured
    ? { kind: 'command', id: boundedId(structured.id), name: null, alias: null, args: [], rawArguments: '', raw: null }
    : typeof value === 'string' ? parseSlashCommand(value) : value;
  if (parsed?.kind === 'unknown') throw new Error(`Unknown Cuppet command: /${parsed.name}`);
  if (parsed?.kind !== 'command') throw new Error('A recognized Cuppet command is required');
  const runtimeCall = (method, params = {}) => request(method, params);
  const result = await executeCommand(parsed, {
    sessionId: boundedId(sessionId),
    call: runtimeCall,
    providerRequest: settings.runtimeValue(),
    host: {
      status: () => request('status', { provider: settings.runtimeValue() }),
      doctor: () => request('doctor', { provider: settings.runtimeValue() }),
      remoteStatus: () => request('remote.status'),
      remoteStart: () => request('remote.start', { setup: true, createInvite: true, provider: settings.runtimeValue() }),
      remoteStop: () => request('remote.stop'),
    },
    provider: desktopProviderAuthority(request),
  }, structured ? validateCommandInput(structured.input, structured.id) : {});
  mainWindow?.webContents.send('cuppet:event', { type: 'command.completed', ...result });
  return result;
}

function desktopProviderAuthority(request) {
  return {
    models: async () => {
      const value = settings.rendererValue();
      const discovered = await request('provider.models', { provider: settings.runtimeValue() }).catch(() => null);
      return {
        configured: value.configured,
        primary: value.primary,
        secondary: value.secondary,
        models: discovered?.models?.length ? discovered.models : value.models,
        catalog: value.catalog,
      };
    },
    providers: async () => {
      const value = settings.rendererValue();
      return { configured: value.configured, selectedProvider: value.primary?.providerID ?? value.providerID ?? null, catalog: value.catalog };
    },
    selectProvider: async (providerID) => {
      const value = settings.rendererValue();
      const requested = String(providerID ?? '').trim();
      const current = value.primary?.providerID ?? value.providerID ?? null;
      const entry = value.catalog?.find?.((item) => item.id === requested || item.integrationIds?.includes?.(requested));
      if (!entry) throw new Error(`Unknown configured provider: ${requested}`);
      if (current !== entry.id && !entry.integrationIds?.includes?.(current)) throw new Error('Switch providers in Provider settings so endpoint and credentials remain host-local.');
      return { selected: true, providerID: current, requiresSettings: false };
    },
    effort: async () => {
      const value = settings.rendererValue();
      const discovered = await request('provider.models', { provider: settings.runtimeValue(), model: value.primary?.modelID ?? '' }).catch(() => null);
      const models = discovered?.models?.length ? discovered.models : value.models;
      const model = models?.find?.((item) => item.providerID === value.primary?.providerID && item.modelID === value.primary?.modelID)
        ?? models?.find?.((item) => item.id === value.primary?.modelID || item.modelID === value.primary?.modelID);
      return { providerID: value.primary?.providerID ?? null, modelID: value.primary?.modelID ?? null, variant: value.primary?.variant ?? null, variants: model?.variants ?? [] };
    },
    setEffort: async (variant) => {
      const value = settings.rendererValue();
      if (!value.primary?.modelID || !value.baseUrl) throw new Error('Configure a primary model before selecting effort.');
      const requested = String(variant ?? '').trim();
      const discovered = await request('provider.models', { provider: settings.runtimeValue(), model: value.primary.modelID }).catch(() => null);
      const models = discovered?.models?.length ? discovered.models : value.models;
      const model = models?.find?.((item) => item.providerID === value.primary.providerID && item.modelID === value.primary.modelID)
        ?? models?.find?.((item) => item.id === value.primary.modelID || item.modelID === value.primary.modelID);
      if (requested && requested !== 'default' && !model?.variants?.includes?.(requested)) throw new Error(`Effort variant is not advertised for ${value.primary.modelID}: ${requested}`);
      const saved = await settings.save({
        providerID: value.primary.providerID,
        baseUrl: value.baseUrl,
        model: value.primary.modelID,
        backgroundModel: value.secondary?.modelID ?? value.primary.modelID,
        primaryEffort: requested === 'default' ? '' : requested,
        secondaryEffort: value.secondary?.variant ?? '',
      });
      await request('provider.config.sync', { provider: settings.runtimeValue() }).catch(() => undefined);
      return { providerID: saved.primary?.providerID ?? null, modelID: saved.primary?.modelID ?? null, variant: saved.primary?.variant ?? null };
    },
  };
}

function validateCliProviderID(value) {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!isLocalCliProvider(id)) throw new Error('Unsupported local CLI provider.');
  return id;
}

function validateProjectPayload(value) {
  const record = value && typeof value === 'object' ? value : {};
  return { path: typeof record.path === 'string' ? record.path : '', name: typeof record.name === 'string' ? record.name.slice(0, 120) : '' };
}
function validateClonePayload(value, withUrl) {
  const record = value && typeof value === 'object' ? value : {};
  const output = { destinationParent: typeof record.destinationParent === 'string' ? record.destinationParent : '', name: typeof record.name === 'string' ? record.name.slice(0, 120) : '' };
  if (withUrl) output.url = typeof record.url === 'string' ? record.url.slice(0, 500) : '';
  else output.nameWithOwner = typeof record.nameWithOwner === 'string' ? record.nameWithOwner.slice(0, 180) : '';
  return output;
}
function validateRemoteStart(value) {
  const record = value && typeof value === 'object' ? value : {};
  return {
    relayUrl: typeof record.relayUrl === 'string' ? record.relayUrl.trim().slice(0, 500) : '',
    apiBase: typeof record.apiBase === 'string' ? record.apiBase.trim().slice(0, 500) : '',
    setup: record.setup === true,
    createInvite: record.createInvite !== false,
  };
}
function validatePermissionReply(value) { return ['once', 'always', 'reject'].includes(value) ? value : 'reject'; }
function validateQuestionAnswers(values) {
  if (!Array.isArray(values)) return [];
  return values.slice(0, 8).map((group) => Array.isArray(group) ? group.slice(0, 12).flatMap((value) => typeof value === 'string' && value.trim() ? [value.trim().slice(0, 512)] : []) : []);
}
function boundedId(value) { return typeof value === 'string' ? value.slice(0, 256) : ''; }
function clampLimit(value){ const numeric=Number(value); return Number.isFinite(numeric)?Math.min(Math.max(Math.trunc(numeric),1),100):50; }
function validatePaths(values) { return Array.isArray(values) ? values.slice(0, 64).flatMap((value) => typeof value === 'string' && value.trim() ? [value.trim().slice(0, 512)] : []) : []; }
async function chooseFolder(options) {
  const title = typeof options?.title === 'string' ? options.title.slice(0, 100) : 'Choose folder';
  const buttonLabel = typeof options?.buttonLabel === 'string' ? options.buttonLabel.slice(0, 40) : 'Choose';
  const result = await dialog.showOpenDialog(mainWindow, { title, buttonLabel, properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : result.filePaths[0] ?? null;
}

async function resolveProjectFile(request, projectId, value, details = false) {
  const id = boundedId(projectId);
  const path = typeof value === 'string' ? value.trim().slice(0, 1024) : '';
  if (!id || !path || path.includes('\0')) throw new Error('A project and file path are required.');
  const project = await request('project.get', { projectId: id });
  if (!project?.canonicalPath || project.missing) throw new Error('The project folder is unavailable.');
  const root = await realpath(project.canonicalPath);
  return details ? resolveProjectFileDetails(root, path) : resolveProjectFilePath(root, path);
}

async function projectFileEditor(request, projectId, value) {
  const { actual } = await resolveProjectFile(request, projectId, value);
  const info = await app.getApplicationInfoForProtocol(pathToFileURL(actual).href).catch(() => null);
  return { path: actual, name: info?.name || '', icon: info && !info.icon.isEmpty() ? info.icon.toDataURL() : null };
}

async function openProjectFile(request, projectId, value) {
  const { actual, child, requested, mode } = await resolveProjectFile(request, projectId, value, true);
  const path = child.replaceAll('\\', '/');
  if (!decideProjectFileOpen({ requested, actual, mode, platform: process.platform }).allowed) {
    shell.showItemInFolder(actual);
    return { opened: false, revealed: true, path };
  }
  const message = await shell.openPath(actual);
  if (message) throw new Error(`Could not open ${child}: ${message}`);
  return { opened: true, path };
}

async function openExternal(value) {
  const raw = typeof value === 'string' ? value.trim().slice(0, 2048) : '';
  let url;
  try { url = new URL(raw); } catch { throw new Error('Invalid external link.'); }
  if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) throw new Error('Only web and email links can be opened externally.');
  await shell.openExternal(url.toString());
  return { opened: true };
}

function createWindow() {
  const isMac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 540,
    minHeight: 400,
    show: false,
    backgroundColor: windowAppearance.background(),
    title: 'Cuppet',
    icon: isMac ? APP_ICON_MACOS : APP_ICON,
    autoHideMenuBar: !isMac,
    ...(isMac ? {
      titleBarStyle: 'hiddenInset',
      vibrancy: 'under-window',
      visualEffectState: 'active',
    } : {
      frame: false,
    }),
    webPreferences: { preload: join(here, '..', 'preload', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.on('focus', () => attention.focused());
  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('cuppet:window:maximize-change', true);
  });
  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('cuppet:window:maximize-change', false);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(?:https?:|mailto:)/i.test(url)) void openExternal(url).catch(() => undefined);
    return { action: 'deny' };
  });
  mainWindow.loadFile(join(here, '..', '..', 'dist-renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = undefined; });
}

app.whenReady().then(bootstrap).catch((error) => { console.error(error); app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0 && runtime) createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { attention.dispose(); windowAppearance?.dispose(); terminals?.stopAll(); void runtime?.stop(); });
