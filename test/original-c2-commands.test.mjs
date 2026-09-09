import test from 'node:test';
import assert from 'node:assert/strict';
import { executeCommand, listCommands, parseSlashCommand } from '../src/runtime/commands.mjs';

const EXPECTED = [
  'status','doctor','remote','remote-stop','memory','auto','background','orchestrator',
  'platform','effort','steer','abort','plan','compact','undo','models',
];
const PALETTE = [
  'cuppet.memory.remember','cuppet.memory.forget','cuppet.memory.clear',
  'cuppet.background.pause','cuppet.background.resume','cuppet.steer.interrupt','cuppet.plan.agent',
];

test('original C2 registry freezes the reviewed slash and palette inventory', () => {
  const all = listCommands();
  const slash = all.filter((item) => !item.paletteOnly);
  const palette = all.filter((item) => item.paletteOnly);
  assert.deepEqual(slash.map((item) => item.slash), EXPECTED);
  assert.deepEqual(palette.map((item) => item.id), PALETTE);
  assert.equal(new Set(all.map((item) => item.id)).size, all.length);
  assert.equal(parseSlashCommand('/remote-control').id, 'remote');
  assert.equal(parseSlashCommand('/login').id, 'platform');
  assert.equal(parseSlashCommand('/models').id, 'models');
  assert.equal(parseSlashCommand('/model').kind, 'unknown');
});

test('slash parser is bounded and preserves quoted/escaped arguments', () => {
  const parsed = parseSlashCommand('/memory "two words" plain\\ value');
  assert.deepEqual(parsed.args, ['two words', 'plain value']);
  assert.equal(parseSlashCommand('ordinary prompt').kind, 'prompt');
  assert.equal(parseSlashCommand('/not-a-command').kind, 'unknown');
  assert.throws(() => parseSlashCommand(`/memory ${'x'.repeat(8192)}`), /maximum length/);
  const many = parseSlashCommand(`/memory ${Array.from({ length: 40 }, (_, i) => `a${i}`).join(' ')}`);
  assert.equal(many.args.length, 32);
  assert.throws(() => parseSlashCommand('/memory "unterminated'), /unterminated/);
});

test('dispatcher delegates to existing authorities and never synthesizes a send for local commands', async () => {
  const calls = [];
  const call = async (method, params = {}) => {
    calls.push({ method, params });
    if (method === 'session.auto.get') return { sessionId: params.sessionId, enabled: false };
    if (method === 'session.auto.set') return { sessionId: params.sessionId, enabled: params.enabled };
    if (method === 'session.mode.get') return { sessionId: params.sessionId, mode: 'build' };
    if (method === 'session.mode.set') return { sessionId: params.sessionId, mode: params.mode };
    if (method === 'session.steer') return { accepted: true, sessionId: params.sessionId, steered: true };
    if (method === 'session.stop') return { stopped: true, sessionId: params.sessionId };
    if (method === 'session.undo') return { undone: true, sessionId: params.sessionId };
    if (method === 'background.status') return { paused: false };
    if (method === 'background.pause') return { paused: true };
    if (method === 'background.resume') return { paused: false };
    if (method === 'background.flush') return { status: 'empty' };
    if (method === 'orchestrator.status') return { enabled: false };
    if (method === 'orchestrator.set') return { enabled: params.enabled };
    if (method === 'memory.query') return { available: true, records: [] };
    if (method === 'context.compact') return { abort: false };
    throw new Error(`unexpected runtime call: ${method}`);
  };
  const context = {
    sessionId: 's1',
    call,
    providerRequest: { model: 'local-model' },
    host: {
      status: async () => ({ ok: true }),
      doctor: async () => ({ ok: true }),
      remoteStatus: async () => ({ running: false }),
      remoteStart: async () => ({ running: true }),
      remoteStop: async () => ({ running: false }),
    },
    provider: {
      models: async () => ({ models: [{ modelID: 'local-model' }] }),
      providers: async () => ({ catalog: [{ id: 'local' }] }),
      selectProvider: async (id) => ({ selected: true, providerID: id }),
      effort: async () => ({ variant: 'medium' }),
      setEffort: async (variant) => ({ variant }),
    },
  };

  assert.equal((await executeCommand(parseSlashCommand('/status'), context)).result.ok, true);
  assert.equal((await executeCommand(parseSlashCommand('/auto on'), context)).result.enabled, true);
  assert.equal((await executeCommand(parseSlashCommand('/plan plan'), context)).result.mode, 'plan');
  await executeCommand(parseSlashCommand('/steer focus on tests'), context);
  await executeCommand(parseSlashCommand('/abort'), context);
  await executeCommand(parseSlashCommand('/undo'), context);
  assert.equal(calls.some((entry) => entry.method === 'session.send'), false);
  const steer = calls.find((entry) => entry.method === 'session.steer');
  assert.deepEqual(steer, { method: 'session.steer', params: { sessionId: 's1', text: 'focus on tests', provider: { model: 'local-model' } } });
});

test('palette-only actions delegate through the same registry contract', async () => {
  const calls = [];
  const call = async (method, params = {}) => { calls.push({ method, params }); return { ok: true, ...params }; };
  const context = { sessionId: 's1', call, host: {}, provider: {}, providerRequest: { model: 'm' } };
  await executeCommand('cuppet.memory.remember', context, { key: 'style', value: 'concise', scope: 'project', pinned: true });
  await executeCommand('cuppet.memory.forget', context, { key: 'style' });
  await executeCommand('cuppet.memory.clear', context, { scope: 'session' });
  await executeCommand('cuppet.background.pause', context, {});
  await executeCommand('cuppet.background.resume', context, {});
  await executeCommand('cuppet.steer.interrupt', context, { text: 'new direction' });
  assert.deepEqual(calls.map((entry) => entry.method), [
    'memory.remember','memory.forget','memory.clear','background.pause','background.resume','session.steer',
  ]);
});
