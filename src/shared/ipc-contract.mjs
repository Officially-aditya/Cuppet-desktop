// The desktop bridge contract. Both generated clients and main-process validation
// come from this file. Keep provider/runtime implementation details in their owners.
const method = (channel, args = [], result = 'any') => ({ channel: 'cuppet:' + channel, args, result });

export const IPC_METHODS = {
  health: method('health'),
  'usage.summary': method('usage:summary', [], 'Types.TokenUsageSummary'),
  'integrations.browserControl.status': method('browser-control:status', [], 'Types.BrowserControlStatus'),
  'integrations.browserControl.connect': method('browser-control:connect', [], 'Types.BrowserControlStatus'),
  'integrations.browserControl.disconnect': method('browser-control:disconnect', [], 'Types.BrowserControlStatus'),
  'cognitive.status': method('cognitive:status', [], 'Types.CognitiveStatus'),
  'cognitive.modeGet': method('session:mode:get', [['sessionId', 'id']], "{ mode?: 'plan' | 'build' }"),
  'cognitive.modeSet': method('session:mode:set', [['sessionId', 'id'], ['mode', 'mode']]),
  'cognitive.orchestratorSet': method('orchestrator:set', [['enabled', 'boolean']]),
  'cognitive.backgroundStatus': method('background:status'),
  'cognitive.backgroundPause': method('background:pause'),
  'cognitive.backgroundResume': method('background:resume'),
  'cognitive.backgroundFlush': method('background:flush', [['sessionId', 'id']]),
  'cognitive.planGet': method('plan:get', [['sessionId', 'id'], ['request?', 'object']]),
  'cognitive.memoryQuery': method('memory:query', [['sessionId', 'id'], ['query', 'object']]),
  'cognitive.memoryGraph': method('memory:graph', [['sessionId', 'id']], 'Types.MemoryGraph'),
  'commands.list': method('command:list', [], 'Types.CommandDefinition[]'),
  'commands.execute': method('command:execute', [['sessionId', 'nullableId'], ['value', 'command']], 'Types.CommandResult'),
  'permissions.list': method('permission:list', [['sessionId?', 'nullableId']], 'Types.PermissionRequest[]'),
  'permissions.reply': method('permission:reply', [['requestId', 'id'], ['reply', 'permissionReply']]),
  'permissions.autoGet': method('session:auto:get', [['sessionId', 'id']]),
  'permissions.autoSet': method('session:auto:set', [['sessionId', 'id'], ['enabled', 'autoMode']]),
  'questions.list': method('question:list', [['sessionId?', 'nullableId']], 'Types.QuestionRequest[]'),
  'questions.reply': method('question:reply', [['requestId', 'id'], ['answers', 'answers']]),
  'questions.reject': method('question:reject', [['requestId', 'id']]),
  'remote.status': method('remote:status', [], 'Types.RemoteStatus'),
  'remote.start': method('remote:start', [['value?', 'object']], '{ status?: Types.RemoteStatus; invite?: Types.RemoteInvite | null }'),
  'remote.stop': method('remote:stop'),
  'remote.invite': method('remote:invite', [['role?', 'role']], 'Types.RemoteInvite'),
  'remote.devices': method('remote:devices', [], 'Types.RemoteDevice[]'),
  'remote.revoke': method('remote:revoke', [['deviceId', 'id']]),
  'cliAgents.status': method('cli-agent:status', [['providerID', 'id']], 'Types.CliAgentStatus'),
  'cliAgents.connect': method('cli-agent:connect', [['providerID', 'id']], 'Types.CliAgentStatus'),
  'codexAuth.status': method('codex-auth:status'),
  'codexAuth.login': method('codex-auth:login'),
  'codexAuth.logout': method('codex-auth:logout'),
  'pe3.status': method('pe3:status', [['sessionId', 'id']]),
  'pe3.observePaths': method('pe3:observe-paths', [['sessionId', 'id'], ['paths', 'paths']]),
  'pe3.workspaceMutation': method('pe3:workspace-mutation', [['sessionId', 'id'], ['paths', 'paths']]),
  'sessions.list': method('session:list', [['projectId?', 'nullableId']], 'Types.Session[]'),
  'sessions.deleted': method('session:deleted:list', [], 'Types.Session[]'),
  'sessions.editedFiles': method('session:edited-files', [['sessionId', 'id']], 'Types.EditedFiles'),
  'sessions.create': method('session:create', [['projectId?', 'nullableId']], 'Types.Session'),
  'sessions.get': method('session:get', [['sessionId', 'id'], ['options?', 'sessionWindow']], 'Types.Session'),
  'sessions.search': method('session:search', [['query', 'text'], ['options?', 'object']], 'Types.SearchResult[]'),
  'sessions.rename': method('session:rename', [['sessionId', 'id'], ['title', 'text']]),
  'sessions.archive': method('session:archive', [['sessionId', 'id']]),
  'sessions.restore': method('session:restore', [['sessionId', 'id']]),
  'sessions.delete': method('session:delete', [['sessionId', 'id']]),
  'sessions.send': method('session:send', [['sessionId', 'id'], ['text', 'text'], ['attachments?', 'attachments']]),
  'sessions.stop': method('session:stop', [['sessionId', 'id']]),
  'sessions.undoStatus': method('session:undo:status', [['sessionId', 'id']]),
  'sessions.undo': method('session:undo', [['sessionId', 'id']]),
  'sessions.queueList': method('session:queue:list', [['sessionId', 'id']], 'Types.QueuedTurn[]'),
  'sessions.queueCancel': method('session:queue:cancel', [['queueId', 'id'], ['sessionId?', 'id']], '{ cancelled: boolean }'),
  'projects.list': method('project:list', [], 'Types.Project[]'),
  'projects.get': method('project:get', [['projectId', 'id']], 'Types.Project'),
  'projects.open': method('project:open', [['projectId', 'id']]),
  'projects.rename': method('project:rename', [['projectId', 'id'], ['name', 'text']]),
  'projects.addLocal': method('project:add-local', [['value', 'object']], 'Types.Project'),
  'projects.cloneUrl': method('project:clone-url', [['value', 'object']], 'Types.Project'),
  'projects.githubList': method('project:github-list', [['query?', 'text']], 'Array<{ nameWithOwner: string; isPrivate?: boolean; defaultBranch?: string }>'),
  'projects.githubClone': method('project:github-clone', [['value', 'object']], 'Types.Project'),
  'projects.relocate': method('project:relocate', [['projectId', 'id'], ['path', 'path']], 'Types.Project'),
  'projects.checkoutBranch': method('project:checkout-branch', [['projectId', 'id'], ['branch', 'text']], 'Types.Project'),
  'projects.remove': method('project:remove', [['projectId', 'id']]),
  'terminal.start': method('terminal:start', [['projectId', 'id'], ['options?', 'object']], 'Types.TerminalSession'),
  'terminal.write': method('terminal:write', [['sessionId', 'id'], ['input', 'text']], '{ written: boolean }'),
  'terminal.resize': method('terminal:resize', [['sessionId', 'id'], ['cols', 'dimension'], ['rows', 'dimension']], '{ resized: boolean }'),
  'terminal.interrupt': method('terminal:interrupt', [['sessionId', 'id']], '{ interrupted: boolean }'),
  'terminal.stop': method('terminal:stop', [['sessionId', 'id']], '{ stopped: boolean }'),
  'native.setAppearance': method('native:appearance', [['preference', 'appearance']], '{ preference: string }'),
  'native.chooseFolder': method('native:choose-folder', [['options?', 'object']], 'string | null'),
  'native.openProjectFile': method('native:open-project-file', [['projectId', 'id'], ['path', 'path']], '{ opened: boolean; revealed?: boolean; path: string }'),
  'native.projectFileEditor': method('native:project-file-editor', [['projectId', 'id'], ['path', 'path']], '{ path: string; name: string; icon: string | null }'),
  'native.linkPreview': method('native:link-preview', [['url', 'text']], '{ url: string; hostname: string; title: string; description: string; siteName: string; image: string | null; icon: string | null }'),
  'native.openExternal': method('native:open-external', [['url', 'text']], '{ opened: boolean }'),
  'native.copyText': method('native:copy-text', [['text', 'text']], '{ copied: boolean }'),
  'native.minimizeWindow': method('native:minimize', [], 'void'),
  'native.toggleMaximizeWindow': method('native:toggle-maximize', [], 'boolean'),
  'native.closeWindow': method('native:close', [], 'void'),
  'native.isWindowMaximized': method('native:is-maximized', [], 'boolean'),
  'settings.get': method('settings:get', [], 'Types.ProviderSettings'),
  'settings.models': method('settings:models', [['options?', 'object']], 'Types.ProviderModelCatalog'),
  'settings.save': method('settings:save', [['value', 'object']], 'Types.ProviderSettings'),
  'sandbox.status': method('sandbox:status', [], 'Types.SandboxStatus'),
};

export const IPC_EVENTS = {
  onEvent: { channel: 'cuppet:event', type: 'Types.RuntimeEvent' },
  'terminal.onEvent': { channel: 'cuppet:terminal:event', type: 'Types.TerminalEvent' },
  'native.onOpenSession': { channel: 'cuppet:attention:open-session', type: 'string' },
  'native.onWindowMaximizeChange': { channel: 'cuppet:window:maximize-change', type: 'boolean' },
};

export const IPC_ARGUMENT_TYPES = {
  id: 'string', nullableId: 'string | null', text: 'string', path: 'string', boolean: 'boolean',
  mode: "'plan' | 'build'", autoMode: "boolean | 'full'", permissionReply: "'once' | 'always' | 'reject'",
  role: "'trusted' | 'viewer'", appearance: "'system' | 'dark' | 'light'",
  object: 'Record<string, unknown>', dimension: 'number', paths: 'string[]', answers: 'string[][]',
  attachments: 'Types.Attachment[]', command: 'string | { id: string; input?: Record<string, unknown> }',
  sessionWindow: '{ limit?: number; beforeSequence?: number }',
};

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function jsonValue(value, depth = 0) {
  if (depth > 12) return false;
  if (value === null || value === undefined || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= 20 * 1024 * 1024;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 2000 && value.every((item) => jsonValue(item, depth + 1));
  return plainObject(value) && Object.keys(value).length <= 1000 && Object.values(value).every((item) => jsonValue(item, depth + 1));
}
function valid(kind, value) {
  switch (kind) {
    case 'id': return typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !value.includes('\0');
    case 'nullableId': return value === null || valid('id', value);
    case 'text': return typeof value === 'string' && value.length <= 2_000_000;
    case 'path': return typeof value === 'string' && value.length > 0 && value.length <= 8192 && !value.includes('\0');
    case 'boolean': return typeof value === 'boolean';
    case 'dimension': return Number.isInteger(value) && value > 0 && value <= 2000;
    case 'sessionWindow': return plainObject(value)
      && Object.keys(value).every(key => ['limit', 'beforeSequence'].includes(key))
      && (value.limit === undefined || (Number.isSafeInteger(value.limit) && value.limit > 0 && value.limit <= 10_000))
      && (value.beforeSequence === undefined || (Number.isSafeInteger(value.beforeSequence) && value.beforeSequence > 0));
    case 'object': return plainObject(value) && jsonValue(value);
    case 'mode': return ['plan', 'build'].includes(value);
    case 'autoMode': return typeof value === 'boolean' || value === 'full';
    case 'permissionReply': return ['once', 'always', 'reject'].includes(value);
    case 'role': return ['viewer', 'trusted'].includes(value);
    case 'appearance': return ['system', 'dark', 'light'].includes(value);
    case 'paths': return Array.isArray(value) && value.length <= 64 && value.every((item) => valid('path', item) && item.length <= 512);
    case 'answers': return Array.isArray(value) && value.length <= 8 && value.every((group) => Array.isArray(group) && group.length <= 12 && group.every((item) => typeof item === 'string' && item.length <= 512));
    case 'attachments': return Array.isArray(value) && value.length <= 16 && value.every((item) => valid('object', item)
      && typeof item.name === 'string' && item.name.length <= 240
      && ['mime', 'path', 'dataUrl'].every((key) => item[key] === undefined || typeof item[key] === 'string')
      && (item.size === undefined || (Number.isFinite(item.size) && item.size >= 0)));
    case 'command': return valid('text', value) || (valid('object', value) && valid('id', value.id) && (value.input === undefined || valid('object', value.input)));
    default: return false;
  }
}

export function validateIpcArguments(name, args) {
  const spec = IPC_METHODS[name];
  if (!spec) throw new Error('Unknown IPC method: ' + name);
  if (!Array.isArray(args) || args.length > spec.args.length) throw new TypeError('Invalid arguments for ' + name);
  spec.args.forEach(([parameter, kind], index) => {
    if (parameter.endsWith('?') && args[index] === undefined) return;
    if (!valid(kind, args[index])) throw new TypeError('Invalid ' + parameter.replace(/\?$/, '') + ' for ' + name);
  });
}
