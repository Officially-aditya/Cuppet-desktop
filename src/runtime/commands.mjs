const MAX_COMMAND_TEXT = 8192;
const MAX_ARGUMENTS = 32;

const DEFINITIONS = Object.freeze([
  command('status', 'status', [], 'Show runtime, project, TST, PE3, and provider status.', 'session.read', 'host'),
  command('doctor', 'doctor', [], 'Run bounded runtime diagnostics.', 'session.read', 'host'),
  command('remote', 'remote', ['remote-control'], 'Show, start, or inspect Remote control.', 'session.read', 'host'),
  command('remote-stop', 'remote-stop', [], 'Stop the local Remote host.', 'session.write', 'host'),
  command('memory', 'memory', [], 'Search verified Cuppet memory for this session.', 'session.read', 'runtime', { requiresSession: true }),
  command('auto', 'auto', [], 'Show or toggle guarded auto for this session.', 'session.write', 'runtime', { requiresSession: true }),
  command('background', 'background', [], 'Show, pause, resume, or flush background memory.', 'session.write', 'runtime'),
  command('orchestrator', 'orchestrator', [], 'Show or toggle orchestrator mode.', 'session.write', 'runtime'),
  command('platform', 'platform', ['login'], 'Show configured provider/platform choices.', 'model.write', 'provider'),
  command('effort', 'effort', [], 'Show or select the primary model effort/reasoning variant.', 'model.write', 'provider'),
  command('steer', 'steer', [], 'Interrupt if needed and steer the current session.', 'session.write', 'runtime', { requiresSession: true, takesText: true }),
  command('abort', 'abort', [], 'Stop the current generation.', 'session.write', 'runtime', { requiresSession: true }),
  command('plan', 'plan', [], 'Show or switch between Plan and Build mode.', 'session.write', 'runtime', { requiresSession: true }),
  command('compact', 'compact', [], 'Prepare the runtime compaction directive for this session.', 'session.write', 'runtime', { requiresSession: true }),
  command('undo', 'undo', [], 'Undo the latest conflict-safe Cuppet mutation.', 'session.write', 'runtime', { requiresSession: true }),
  command('models', 'models', [], 'List host-advertised coding models and the selected model.', 'session.read', 'provider'),

  palette('cuppet.memory.remember', 'Remember memory', 'Persist an explicit user memory through TST.', 'session.write', 'runtime'),
  palette('cuppet.memory.forget', 'Forget memory', 'Forget one explicit memory key.', 'session.write', 'runtime'),
  palette('cuppet.memory.clear', 'Clear memory scope', 'Clear a bounded memory scope.', 'session.write', 'runtime'),
  palette('cuppet.background.pause', 'Pause background memory', 'Pause background enrichment.', 'session.write', 'runtime'),
  palette('cuppet.background.resume', 'Resume background memory', 'Resume background enrichment.', 'session.write', 'runtime'),
  palette('cuppet.steer.interrupt', 'Interrupt and steer', 'Stop active work and immediately steer the session.', 'session.write', 'runtime'),
  palette('cuppet.plan.agent', 'Plan / Build mode', 'Reviewed replacement for the old OpenCode plan-agent picker.', 'session.write', 'runtime'),
]);

const BY_SLASH = new Map();
const BY_ID = new Map();
for (const item of DEFINITIONS) {
  BY_ID.set(item.id, item);
  if (item.slash) {
    BY_SLASH.set(item.slash, item);
    for (const alias of item.aliases) BY_SLASH.set(alias, item);
  }
}

export function listCommands() {
  return DEFINITIONS.map(projectDefinition);
}

export function getCommand(id) {
  const item = BY_ID.get(String(id ?? ''));
  return item ? projectDefinition(item) : null;
}

export function parseSlashCommand(input) {
  const text = typeof input === 'string' ? input.trim() : '';
  if (!text.startsWith('/')) return { kind: 'prompt', text };
  if (text.length > MAX_COMMAND_TEXT) throw new Error('command exceeds maximum length');
  const match = text.match(/^\/([A-Za-z][A-Za-z0-9-]*)(?:\s+([\s\S]*))?$/);
  if (!match) return { kind: 'unknown', name: text.slice(1).split(/\s/, 1)[0].slice(0, 80), raw: text };
  const name = match[1].toLowerCase();
  const definition = BY_SLASH.get(name);
  if (!definition) return { kind: 'unknown', name, raw: text };
  const rawArguments = (match[2] ?? '').trim();
  return {
    kind: 'command',
    id: definition.id,
    name: definition.slash,
    alias: name === definition.slash ? null : name,
    args: tokenize(rawArguments),
    rawArguments,
    raw: text,
    definition: projectDefinition(definition),
  };
}

export async function executeCommand(parsedOrId, context = {}, input = {}) {
  const invocation = typeof parsedOrId === 'string'
    ? invocationForId(parsedOrId, input)
    : parsedOrId;
  if (!invocation || invocation.kind !== 'command') throw new Error('recognized command invocation is required');
  const definition = BY_ID.get(invocation.id);
  if (!definition) throw new Error(`unknown command: ${invocation.id}`);
  if (definition.requiresSession && !context.sessionId) throw new Error(`/${definition.slash} requires an active session`);

  const call = requiredFunction(context.call, 'runtime call');
  const host = context.host ?? {};
  const provider = context.provider ?? {};
  const args = invocation.args ?? [];
  const rawArguments = invocation.rawArguments ?? '';
  const sessionId = context.sessionId ?? null;
  let result;

  switch (definition.id) {
    case 'status': result = await requiredFunction(host.status, 'status authority')(); break;
    case 'doctor': result = await requiredFunction(host.doctor, 'doctor authority')(); break;
    case 'remote': result = await executeRemote(host, args); break;
    case 'remote-stop': result = await requiredFunction(host.remoteStop, 'remote stop authority')(); break;
    case 'memory': result = await call('memory.query', { sessionId, query: rawArguments, limit: 20 }); break;
    case 'auto': result = await executeAuto(call, sessionId, args); break;
    case 'background': result = await executeBackground(call, sessionId, args); break;
    case 'orchestrator': result = await executeOrchestrator(call, args); break;
    case 'platform': result = await executePlatform(provider, args); break;
    case 'effort': result = await executeEffort(provider, args); break;
    case 'steer': {
      if (!rawArguments) throw new Error('/steer requires an instruction');
      result = await call('session.steer', { sessionId, text: rawArguments, provider: context.providerRequest ?? {} });
      break;
    }
    case 'abort': result = await call('session.stop', { sessionId }); break;
    case 'plan': result = await executePlan(call, sessionId, args); break;
    case 'compact': result = await call('context.compact', { sessionId, provider: context.providerRequest ?? {} }); break;
    case 'undo': result = await call('session.undo', { sessionId }); break;
    case 'models': result = await requiredFunction(provider.models, 'model catalog authority')(); break;
    case 'cuppet.memory.remember': result = await executeMemoryRemember(call, sessionId, input); break;
    case 'cuppet.memory.forget': result = await executeMemoryForget(call, sessionId, input); break;
    case 'cuppet.memory.clear': result = await executeMemoryClear(call, sessionId, input); break;
    case 'cuppet.background.pause': result = await call('background.pause', {}); break;
    case 'cuppet.background.resume': result = await call('background.resume', {}); break;
    case 'cuppet.steer.interrupt': {
      const text = String(input.text ?? '').trim();
      if (!text) throw new Error('interrupt-and-steer requires text');
      result = await call('session.steer', { sessionId, text, provider: context.providerRequest ?? {}, interrupt: true });
      break;
    }
    case 'cuppet.plan.agent': result = await executePlan(call, sessionId, [String(input.mode ?? '')]); break;
    default: throw new Error(`command is not executable: ${definition.id}`);
  }

  return {
    command: true,
    id: definition.id,
    slash: definition.slash ? `/${definition.slash}` : null,
    alias: invocation.alias ?? null,
    sessionId,
    result,
    presentation: summarize(definition.id, result),
  };
}

export function isRecognizedSlash(input) {
  return parseSlashCommand(input).kind === 'command';
}

function command(id, slash, aliases, description, scope, authority, options = {}) {
  return Object.freeze({ id, slash, aliases: Object.freeze([...aliases]), description, scope, authority, paletteOnly: false, requiresSession: options.requiresSession === true, takesText: options.takesText === true });
}
function palette(id, title, description, scope, authority) {
  return Object.freeze({ id, slash: null, aliases: Object.freeze([]), title, description, scope, authority, paletteOnly: true, requiresSession: true, takesText: false });
}
function projectDefinition(item) {
  return { id: item.id, slash: item.slash, aliases: [...item.aliases], title: item.title ?? null, description: item.description, scope: item.scope, authority: item.authority, paletteOnly: item.paletteOnly, requiresSession: item.requiresSession, takesText: item.takesText };
}
function invocationForId(id, input) {
  const definition = BY_ID.get(String(id ?? ''));
  if (!definition) throw new Error(`unknown command: ${id}`);
  return { kind: 'command', id: definition.id, name: definition.slash, alias: null, args: Array.isArray(input.args) ? input.args.slice(0, MAX_ARGUMENTS).map(String) : [], rawArguments: typeof input.rawArguments === 'string' ? input.rawArguments.slice(0, MAX_COMMAND_TEXT) : '', definition: projectDefinition(definition) };
}
function tokenize(value) {
  if (!value) return [];
  const tokens = []; let current = ''; let quote = null; let escaping = false;
  for (const ch of value) {
    if (escaping) { current += ch; escaping = false; continue; }
    if (ch === '\\') { escaping = true; continue; }
    if (quote) { if (ch === quote) quote = null; else current += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) { if (current) { tokens.push(current); current = ''; if (tokens.length >= MAX_ARGUMENTS) break; } continue; }
    current += ch;
  }
  if (quote) throw new Error('unterminated command quote');
  if (escaping) current += '\\';
  if (current && tokens.length < MAX_ARGUMENTS) tokens.push(current);
  return tokens;
}
async function executeAuto(call, sessionId, args) {
  const current = await call('session.auto.get', { sessionId });
  const action = normalizeToggle(args[0]);
  if (action === 'status') return current;
  const enabled = action === 'toggle' ? !current.enabled : action === 'on';
  return call('session.auto.set', { sessionId, enabled });
}
async function executeBackground(call, sessionId, args) {
  const action = String(args[0] ?? 'status').toLowerCase();
  if (action === 'status') return call('background.status', {});
  if (action === 'flush') {
    if (!sessionId) throw new Error('/background flush requires an active session');
    return call('background.flush', { sessionId });
  }
  if (['on', 'resume'].includes(action)) return call('background.resume', {});
  if (['off', 'pause'].includes(action)) return call('background.pause', {});
  if (action === 'toggle') {
    const current = await call('background.status', {});
    return call(current.paused ? 'background.resume' : 'background.pause', {});
  }
  throw new Error('/background accepts status, on, off, pause, resume, toggle, or flush');
}
async function executeOrchestrator(call, args) {
  const current = await call('orchestrator.status', {});
  const action = normalizeToggle(args[0]);
  if (action === 'status') return current;
  const enabled = action === 'toggle' ? !current.enabled : action === 'on';
  return call('orchestrator.set', { enabled });
}
async function executePlan(call, sessionId, args) {
  const current = await call('session.mode.get', { sessionId });
  const raw = String(args[0] ?? 'status').toLowerCase();
  if (raw === 'status') return current;
  const mode = raw === 'toggle' ? (current.mode === 'plan' ? 'build' : 'plan') : raw;
  if (!['plan', 'build'].includes(mode)) throw new Error('/plan accepts plan, build, toggle, or status');
  return call('session.mode.set', { sessionId, mode });
}
async function executeRemote(host, args) {
  const action = String(args[0] ?? 'status').toLowerCase();
  if (action === 'status') return requiredFunction(host.remoteStatus, 'remote status authority')();
  if (action === 'start' || action === 'on') return requiredFunction(host.remoteStart, 'remote start authority')();
  if (action === 'stop' || action === 'off') return requiredFunction(host.remoteStop, 'remote stop authority')();
  throw new Error('/remote accepts status, start, or stop');
}
async function executePlatform(provider, args) {
  if (!args.length) return requiredFunction(provider.providers, 'provider catalog authority')();
  return requiredFunction(provider.selectProvider, 'provider selection authority')(args[0]);
}
async function executeEffort(provider, args) {
  if (!args.length || String(args[0]).toLowerCase() === 'status') return requiredFunction(provider.effort, 'effort authority')();
  return requiredFunction(provider.setEffort, 'effort selection authority')(args[0]);
}
async function executeMemoryRemember(call, sessionId, input) {
  const key = String(input.key ?? '').trim(); const value = String(input.value ?? '').trim();
  if (!key || !value) throw new Error('memory remember requires key and value');
  return call('memory.remember', { sessionId, key, value, scope: input.scope ?? 'project', pinned: input.pinned === true });
}
async function executeMemoryForget(call, sessionId, input) {
  const key = String(input.key ?? '').trim(); if (!key) throw new Error('memory forget requires key');
  return call('memory.forget', { sessionId, key });
}
async function executeMemoryClear(call, sessionId, input) {
  return call('memory.clear', { sessionId, scope: input.scope ?? 'session' });
}
function normalizeToggle(value) {
  const raw = String(value ?? 'status').toLowerCase();
  if (['status'].includes(raw)) return 'status';
  if (['on', 'enable', 'enabled', 'resume'].includes(raw)) return 'on';
  if (['off', 'disable', 'disabled', 'pause'].includes(raw)) return 'off';
  if (raw === 'toggle') return 'toggle';
  throw new Error('expected status, on, off, or toggle');
}
function requiredFunction(value, label) { if (typeof value !== 'function') throw new Error(`${label} is unavailable on this surface`); return value; }
function summarize(id, result) {
  if (id === 'auto') return `Guarded auto: ${result?.enabled ? 'on' : 'off'}`;
  if (id === 'orchestrator') return `Orchestrator: ${result?.enabled ? 'on' : 'off'}`;
  if (id === 'background') return result?.paused === true ? 'Background memory: paused' : result?.paused === false ? 'Background memory: active' : 'Background memory updated';
  if (id === 'plan' || id === 'cuppet.plan.agent') return `Mode: ${result?.mode ?? 'updated'}`;
  if (id === 'abort') return result?.stopped ? 'Generation stopped.' : 'No active generation.';
  if (id === 'undo') return result?.undone ? 'Latest Cuppet mutation undone.' : result?.reason ?? 'Nothing to undo.';
  if (id === 'remote-stop') return 'Remote host stopped.';
  if (id === 'effort') return `Effort: ${result?.variant ?? result?.selectedVariant ?? 'default'}`;
  return null;
}
