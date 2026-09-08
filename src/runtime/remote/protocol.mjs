export const PROTOCOL_VERSION = 1;
export const MINIMUM_CLIENT_VERSION = 1;
export const MAX_FRAME_BYTES = 512 * 1024;
export const REMOTE_SCOPES = ['session.read','session.write','permission.write','question.write','model.write'];
export const DEFAULT_DEVICE_SCOPES = [...REMOTE_SCOPES];
export const VIEWER_DEVICE_SCOPES = ['session.read'];

export const COMMAND_SCOPES = Object.freeze({
  'host.get':'session.read',
  'status':'session.read',
  'doctor':'session.read',
  'workspace.list':'session.read',
  'session.list':'session.read',
  'session.snapshot':'session.read',
  'session.messages':'session.read',
  'permission.list':'session.read',
  'question.list':'session.read',
  'model.list':'session.read',
  'provider.list':'session.read',
  'agent.mode.get':'session.read',
  'workspace.attach':'session.write',
  'session.new':'session.write',
  'session.resume':'session.write',
  'session.submit':'session.write',
  'session.steer':'session.write',
  'session.abort':'session.write',
  'session.undo':'session.write',
  'session.compact':'session.write',
  'plan.set':'session.write',
  'agent.mode.set':'session.write',
  'permission.reply':'permission.write',
  'question.reply':'question.write',
  'question.reject':'question.write',
  'model.select':'model.write',
  'provider.select':'model.write',
});

export function scopeForCommand(type) { return COMMAND_SCOPES[String(type)] ?? null; }

export function encodeFrame(value) {
  const data = JSON.stringify(value);
  if (Buffer.byteLength(data, 'utf8') > MAX_FRAME_BYTES) throw new Error(`frame exceeds ${MAX_FRAME_BYTES} bytes`);
  return data;
}

export function parseCommandFrame(data) {
  if (typeof data !== 'string' || Buffer.byteLength(data, 'utf8') > MAX_FRAME_BYTES) throw new Error('frame too large');
  let parsed;
  try { parsed = JSON.parse(data); } catch { throw new Error('malformed JSON'); }
  if (!record(parsed)) throw new Error('command must be an object');
  if (parsed.version !== PROTOCOL_VERSION) throw new Error(`unsupported protocol version: ${parsed.version ?? 'missing'}`);
  if (!boundedString(parsed.id, 1, 128)) throw new Error('invalid command id');
  if (!boundedString(parsed.type, 1, 64)) throw new Error('invalid command type');
  if (!Number.isInteger(parsed.ts) || parsed.ts < 0) throw new Error('invalid command timestamp');
  if (parsed.hostId !== undefined && !boundedString(parsed.hostId, 1, 128)) throw new Error('invalid host id');
  if (parsed.sessionId !== undefined && !boundedString(parsed.sessionId, 1, 256)) throw new Error('invalid session id');
  if (!scopeForCommand(parsed.type)) throw new Error(`unsupported command type: ${parsed.type}`);
  return parsed;
}

export function publicEventFor(event) {
  if (!record(event)) return undefined;
  switch (event.type) {
    case 'message.delta': return { type:'assistant.text.delta', payload:{ text:String(event.delta ?? '').slice(0,128*1024) }, sessionId:stringOr(event.sessionId) };
    case 'tool.started': return { type:'tool.started', payload:{ callID:event.callId ?? event.executionId ?? null, name:event.tool ?? null }, sessionId:stringOr(event.sessionId) };
    case 'tool.finished': return { type:'tool.completed', payload:{ callID:event.callId ?? event.executionId ?? null, success:event.success === true, name:event.tool ?? null, paths:Array.isArray(event.paths) ? event.paths.slice(0,64) : [] }, sessionId:stringOr(event.sessionId) };
    case 'permission.requested': return { type:'permission.requested', payload:{ request:event.request }, sessionId:stringOr(event.request?.sessionId ?? event.sessionId) };
    case 'permission.resolved': return { type:'permission.resolved', payload:{ requestID:event.requestId, reply:event.reply ?? null }, sessionId:stringOr(event.sessionId) };
    case 'session.updated': return { type:'session.updated', payload:{ sessionID:event.session?.id ?? event.sessionId ?? null }, sessionId:stringOr(event.session?.id ?? event.sessionId) };
    case 'run.finished': return { type:'session.idle', payload:{}, sessionId:stringOr(event.sessionId) };
    case 'run.started': return { type:'session.updated', payload:{ sessionID:event.sessionId, running:true }, sessionId:stringOr(event.sessionId) };
    case 'pe3.routed': return { type:'session.updated', payload:{ sessionID:event.targetSessionId, sourceSessionID:event.sourceSessionId, route:event.action }, sessionId:stringOr(event.targetSessionId) };
    case 'runtime.error': return { type:'agent.error', payload:{ message:String(event.message ?? 'runtime error').slice(0,1000) }, sessionId:stringOr(event.sessionId) };
    default: return undefined;
  }
}

export function eventFrame(hostId, seq, type, payload, sessionId) {
  return { version:PROTOCOL_VERSION, seq, hostId, ts:Date.now(), type, ...(sessionId ? {sessionId} : {}), ...(payload !== undefined ? {payload} : {}) };
}

function record(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function boundedString(value, min, max) { return typeof value === 'string' && value.length >= min && value.length <= max; }
function stringOr(value) { return typeof value === 'string' && value ? value : undefined; }
