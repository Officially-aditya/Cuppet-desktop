import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeClient } from './runtime-client.mjs';
import { ProviderSettingsStore } from './provider-settings.mjs';
import { executeCommand, listCommands, parseSlashCommand } from '../runtime/commands.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let runtime;
let settings;
let mainWindow;

async function bootstrap() {
  const userData = app.getPath('userData');
  settings = new ProviderSettingsStore(join(userData, 'provider-settings.json'));
  await settings.load();
  runtime = new RuntimeClient({ entry: join(here, '..', 'runtime', 'main.mjs'), dataDir: join(userData, 'runtime') });
  runtime.on('event', (event) => mainWindow?.webContents.send('cuppet:event', event));
  runtime.on('exit', (info) => mainWindow?.webContents.send('cuppet:event', { type: 'runtime.error', message: `Runtime exited unexpectedly${info?.code !== null ? ` (code ${info.code})` : ''}` }));
  await runtime.start();
  await runtime.request('remote.provider-config', { provider: settings.runtimeValue() }).catch(() => undefined);
  registerIpc();
  createWindow();
}

function registerIpc() {
  const request = (method, params) => runtime.request(method, params);
  ipcMain.handle('cuppet:health', () => request('health'));
  ipcMain.handle('cuppet:cognitive:status', () => request('cognitive.status'));
  ipcMain.handle('cuppet:session:mode:get', (_event, sessionId) => request('session.mode.get', { sessionId }));
  ipcMain.handle('cuppet:session:mode:set', (_event, sessionId, mode) => request('session.mode.set', { sessionId, mode }));
  ipcMain.handle('cuppet:session:auto:get', (_event, sessionId) => request('session.auto.get', { sessionId }));
  ipcMain.handle('cuppet:session:auto:set', (_event, sessionId, enabled) => request('session.auto.set', { sessionId, enabled: Boolean(enabled) }));
  ipcMain.handle('cuppet:permission:list', (_event, sessionId) => request('permission.list', { sessionId: sessionId ?? null }));
  ipcMain.handle('cuppet:permission:reply', (_event, requestId, reply) => request('permission.reply', { requestId, reply: validatePermissionReply(reply) }));
  ipcMain.handle('cuppet:question:list', (_event, sessionId) => request('question.list', { sessionId: sessionId ?? null }));
  ipcMain.handle('cuppet:question:reply', (_event, requestId, answers) => request('question.reply', { requestId: boundedId(requestId), answers: validateQuestionAnswers(answers) }));
  ipcMain.handle('cuppet:question:reject', (_event, requestId) => request('question.reject', { requestId: boundedId(requestId) }));
  ipcMain.handle('cuppet:orchestrator:set', (_event, enabled) => request('orchestrator.set', { enabled: Boolean(enabled) }));
  ipcMain.handle('cuppet:background:status', () => request('background.status'));
  ipcMain.handle('cuppet:background:pause', () => request('background.pause'));
  ipcMain.handle('cuppet:background:resume', () => request('background.resume'));
  ipcMain.handle('cuppet:background:flush', (_event, sessionId) => request('background.flush', { sessionId }));
  ipcMain.handle('cuppet:plan:get', (_event, sessionId, requestValue) => request('plan.get', { sessionId, request: requestValue }));
  ipcMain.handle('cuppet:memory:query', (_event, sessionId, query) => request('memory.query', { sessionId, query }));
  ipcMain.handle('cuppet:pe3:status', (_event, sessionId) => request('pe3.status', { sessionId }));
  ipcMain.handle('cuppet:pe3:observe-paths', (_event, sessionId, paths) => request('pe3.observe-paths', { sessionId, paths: validatePaths(paths) }));
  ipcMain.handle('cuppet:pe3:workspace-mutation', (_event, sessionId, paths) => request('pe3.workspace-mutation', { sessionId, paths: validatePaths(paths) }));

  ipcMain.handle('cuppet:remote:status', () => request('remote.status'));
  ipcMain.handle('cuppet:remote:start', (_event, value) => request('remote.start', { ...validateRemoteStart(value), provider: settings.runtimeValue() }));
  ipcMain.handle('cuppet:remote:stop', () => request('remote.stop'));
  ipcMain.handle('cuppet:remote:invite', (_event, role) => request('remote.invite', { role: role === 'viewer' ? 'viewer' : 'trusted' }));
  ipcMain.handle('cuppet:remote:devices', () => request('remote.devices'));
  ipcMain.handle('cuppet:remote:revoke', (_event, deviceId) => request('remote.revoke', { deviceId: typeof deviceId === 'string' ? deviceId.slice(0, 128) : '' }));

  ipcMain.handle('cuppet:command:list', () => listCommands());
  ipcMain.handle('cuppet:command:execute', async (_event, sessionId, value) => executeDesktopCommand(request, sessionId, value));

  ipcMain.handle('cuppet:session:list', (_event, projectId) => request('session.list', projectId === undefined ? {} : { projectId }));
  ipcMain.handle('cuppet:session:create', (_event, projectId) => request('session.create', { projectId: projectId ?? null }));
  ipcMain.handle('cuppet:session:get', (_event, sessionId) => request('session.get', { sessionId }));
  ipcMain.handle('cuppet:session:search', (_event, query, options) => request('session.search', { query: typeof query === 'string' ? query.slice(0, 512) : '', limit: clampLimit(options?.limit), includeArchived: options?.includeArchived === true }));
  ipcMain.handle('cuppet:session:rename', (_event, sessionId, title) => request('session.rename', { sessionId: boundedId(sessionId), title: typeof title === 'string' ? title.trim().slice(0, 160) : '' }));
  ipcMain.handle('cuppet:session:archive', (_event, sessionId) => request('session.archive', { sessionId: boundedId(sessionId) }));
  ipcMain.handle('cuppet:session:restore', (_event, sessionId) => request('session.restore', { sessionId: boundedId(sessionId) }));
  ipcMain.handle('cuppet:session:delete', (_event, sessionId) => request('session.delete', { sessionId: boundedId(sessionId) }));
  ipcMain.handle('cuppet:session:send', async (_event, sessionId, text, attachments) => {
    const parsed = parseSlashCommand(text);
    if (parsed.kind === 'unknown') throw new Error(`Unknown Cuppet command: /${parsed.name}`);
    if (parsed.kind === 'command') return executeDesktopCommand(request, sessionId, parsed);
    return request('session.send', { sessionId, text, attachments: validateAttachments(attachments), provider: settings.runtimeValue() });
  });
  ipcMain.handle('cuppet:session:stop', (_event, sessionId) => request('session.stop', { sessionId }));
  ipcMain.handle('cuppet:session:undo:status', (_event, sessionId) => request('session.undo.status', { sessionId: boundedId(sessionId) }));
  ipcMain.handle('cuppet:session:undo', (_event, sessionId) => request('session.undo', { sessionId: boundedId(sessionId) }));

  ipcMain.handle('cuppet:project:list', () => request('project.list'));
  ipcMain.handle('cuppet:project:get', (_event, projectId) => request('project.get', { projectId }));
  ipcMain.handle('cuppet:project:open', (_event, projectId) => request('project.open', { projectId }));
  ipcMain.handle('cuppet:project:rename', (_event, projectId, name) => request('project.rename', { projectId: boundedId(projectId), name: typeof name === 'string' ? name.trim().slice(0, 120) : '' }));
  ipcMain.handle('cuppet:project:add-local', (_event, value) => request('project.add-local', validateProjectPayload(value)));
  ipcMain.handle('cuppet:project:clone-url', (_event, value) => request('project.clone-url', validateClonePayload(value, true)));
  ipcMain.handle('cuppet:project:github-list', (_event, query) => request('project.github-list', { query: typeof query === 'string' ? query.slice(0, 120) : '' }));
  ipcMain.handle('cuppet:project:github-clone', (_event, value) => request('project.github-clone', validateClonePayload(value, false)));
  ipcMain.handle('cuppet:project:relocate', (_event, projectId, path) => request('project.relocate', { projectId, path }));
  ipcMain.handle('cuppet:project:remove', (_event, projectId) => request('project.remove', { projectId }));
  ipcMain.handle('cuppet:native:choose-folder', (_event, options) => chooseFolder(options));

  ipcMain.handle('cuppet:settings:get', () => settings.rendererValue());
  ipcMain.handle('cuppet:settings:save', async (_event, value) => {
    const result = await settings.save(value);
    await request('remote.provider-config', { provider: settings.runtimeValue() }).catch(() => undefined);
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
  }, structured ? validateCommandInput(structured.input) : {});
  mainWindow?.webContents.send('cuppet:event', { type: 'command.completed', ...result });
  return result;
}

function desktopProviderAuthority(request) {
  return {
    models: async () => {
      const value = settings.rendererValue();
      return { configured: value.configured, primary: value.primary, secondary: value.secondary, models: value.models, catalog: value.catalog };
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
      const model = value.models?.find?.((item) => item.providerID === value.primary?.providerID && item.modelID === value.primary?.modelID);
      return { providerID: value.primary?.providerID ?? null, modelID: value.primary?.modelID ?? null, variant: value.primary?.variant ?? null, variants: model?.variants ?? [] };
    },
    setEffort: async (variant) => {
      const value = settings.rendererValue();
      if (!value.primary?.modelID || !value.baseUrl) throw new Error('Configure a primary model before selecting effort.');
      const requested = String(variant ?? '').trim();
      const model = value.models?.find?.((item) => item.providerID === value.primary.providerID && item.modelID === value.primary.modelID);
      if (requested && requested !== 'default' && !model?.variants?.includes?.(requested)) throw new Error(`Effort variant is not advertised for ${value.primary.modelID}: ${requested}`);
      const saved = await settings.save({
        providerID: value.primary.providerID,
        baseUrl: value.baseUrl,
        model: value.primary.modelID,
        backgroundModel: value.secondary?.modelID ?? value.primary.modelID,
        primaryEffort: requested === 'default' ? '' : requested,
        secondaryEffort: value.secondary?.variant ?? '',
      });
      await request('remote.provider-config', { provider: settings.runtimeValue() }).catch(() => undefined);
      return { providerID: saved.primary?.providerID ?? null, modelID: saved.primary?.modelID ?? null, variant: saved.primary?.variant ?? null };
    },
  };
}

function validateCommandInput(value) {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    ...(typeof record.key === 'string' ? { key: record.key.trim().slice(0, 240) } : {}),
    ...(typeof record.value === 'string' ? { value: record.value.trim().slice(0, 4000) } : {}),
    ...(typeof record.text === 'string' ? { text: record.text.trim().slice(0, 8192) } : {}),
    ...(['session', 'project', 'global'].includes(record.scope) ? { scope: record.scope } : {}),
    ...(['plan', 'build'].includes(record.mode) ? { mode: record.mode } : {}),
    ...(record.pinned === true ? { pinned: true } : {}),
  };
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
function validateAttachments(values) {
  if (!Array.isArray(values)) return [];
  return values.slice(0, 16).flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const name = typeof value.name === 'string' ? value.name.trim().slice(0, 240) : '';
    const mime = typeof value.mime === 'string' ? value.mime.trim().slice(0, 128) : '';
    const path = typeof value.path === 'string' ? value.path.trim().slice(0, 512) : '';
    if (!name && !path) return [];
    return [{ ...(name ? { name } : {}), ...(mime ? { mime } : {}), ...(path ? { path } : {}), ...(Number.isFinite(value.size) ? { size: Math.max(0, Math.trunc(value.size)) } : {}) }];
  });
}
async function chooseFolder(options) {
  const title = typeof options?.title === 'string' ? options.title.slice(0, 100) : 'Choose folder';
  const buttonLabel = typeof options?.buttonLabel === 'string' ? options.buttonLabel.slice(0, 40) : 'Choose';
  const result = await dialog.showOpenDialog(mainWindow, { title, buttonLabel, properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : result.filePaths[0] ?? null;
}

function createWindow() {
  mainWindow = new BrowserWindow({ width: 1180, height: 800, minWidth: 860, minHeight: 620, show: false, backgroundColor: '#0d0f12', title: 'Cuppet', webPreferences: { preload: join(here, '..', 'preload', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(join(here, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = undefined; });
}

app.whenReady().then(bootstrap).catch((error) => { console.error(error); app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0 && runtime) createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { void runtime?.stop(); });
