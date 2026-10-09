import test from 'node:test';
import assert from 'node:assert/strict';
import { executeCommand, listCommands, parseSlashCommand } from '../src/runtime/commands.mjs';

const EXPECTED = ['status','doctor','memory','background','compact','undo'];
const REMOVED = [
  'remote','remote-stop','remote-control','auto','orchestrator','platform','login',
  'effort','steer','abort','plan','models',
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
  for (const name of REMOVED) {
    assert.equal(parseSlashCommand(`/${name}`).kind, 'unknown', name);
    assert.equal(parseSlashCommand(`/${name} status`).kind, 'unknown', name);
  }
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
    if (method === 'session.undo') return { undone: true, sessionId: params.sessionId };
    if (method === 'background.status') return { paused: false };
    if (method === 'background.pause') return { paused: true };
    if (method === 'background.resume') return { paused: false };
    if (method === 'background.flush') return { status: 'empty' };
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
    },
    provider: {},
  };

  assert.equal((await executeCommand(parseSlashCommand('/status'), context)).result.ok, true);
  assert.equal((await executeCommand(parseSlashCommand('/doctor'), context)).result.ok, true);
  assert.equal((await executeCommand(parseSlashCommand('/memory two words'), context)).result.available, true);
  assert.equal((await executeCommand(parseSlashCommand('/background pause'), context)).result.paused, true);
  assert.equal((await executeCommand(parseSlashCommand('/compact'), context)).result.abort, false);
  assert.equal((await executeCommand(parseSlashCommand('/undo'), context)).result.undone, true);
  assert.deepEqual(calls, [
    { method: 'memory.query', params: { sessionId: 's1', query: 'two words', limit: 20 } },
    { method: 'background.pause', params: {} },
    { method: 'context.compact', params: { sessionId: 's1', provider: { model: 'local-model' } } },
    { method: 'session.undo', params: { sessionId: 's1' } },
  ]);
  for (const id of REMOVED) {
    await assert.rejects(() => executeCommand(id, context), /unknown command/);
  }
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
  await executeCommand('cuppet.plan.agent', context, { mode: 'plan' });
  assert.deepEqual(calls.map((entry) => entry.method), [
    'memory.remember','memory.forget','memory.clear','background.pause','background.resume','session.steer',
    'session.mode.get','session.mode.set',
  ]);
});
