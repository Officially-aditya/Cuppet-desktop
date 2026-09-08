import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationDatabase } from '../src/runtime/database.mjs';
import { LosslessPlanStore } from '../src/runtime/lossless-plan.mjs';
import { buildRuntimeDoctor, buildRuntimeStatus } from '../src/runtime/diagnostics.mjs';
import { RemoteCommandAdapter } from '../src/runtime/remote/commands.mjs';
import { scopeForCommand } from '../src/runtime/remote/protocol.mjs';

const providerConfig = {
  providerID: 'openai-compatible',
  baseUrl: 'https://user:password@example.invalid/v1',
  apiKey: 'sk-must-remain-local',
  model: 'primary-model',
  backgroundModel: 'secondary-model',
};

test('session fork copies durable transcript and project binding without cloning tool audit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-e-fork-'));
  const path = join(dir, 'conversations.sqlite3');
  try {
    const db = new ConversationDatabase(path);
    db.createProject({ id: 'p1', name: 'Project', canonicalPath: join(dir, 'project') });
    db.createSession({ id: 'source', projectId: 'p1', title: 'Original' });
    db.appendMessage({ id: 'u1', sessionId: 'source', role: 'user', content: 'Implement the migration.' });
    db.appendMessage({ id: 'a1', sessionId: 'source', role: 'assistant', content: 'Working on it.' });
    db.createToolExecution({ id: 'tool1', sessionId: 'source', callId: 'call1', toolName: 'workspace_write', argumentsJson: '{"path":"a.txt"}' });
    db.finishToolExecution('tool1', { status: 'complete', output: 'Wrote file.', permissionSource: 'once' });

    const forked = db.forkSession({ sourceSessionId: 'source', id: 'fork' });
    const source = db.getSession('source');
    const target = db.getSession('fork');

    assert.equal(target.projectId, 'p1');
    assert.equal(target.title, 'Original (fork)');
    assert.deepEqual(target.messages.map((message) => [message.role, message.content, message.status]), source.messages.map((message) => [message.role, message.content, message.status]));
    assert.equal(target.toolExecutions.length, 0);
    assert.equal(source.toolExecutions.length, 1);
    assert.notEqual(forked.messageMap.u1, 'u1');
    assert.equal(target.messages[0].id, forked.messageMap.u1);
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('session fork fails closed while source generation is still streaming', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-e-stream-'));
  const path = join(dir, 'conversations.sqlite3');
  try {
    const db = new ConversationDatabase(path);
    db.createSession({ id: 'source' });
    db.appendMessage({ id: 'a1', sessionId: 'source', role: 'assistant', content: 'partial', status: 'streaming' });
    assert.throws(() => db.forkSession({ sourceSessionId: 'source', id: 'fork' }), /while it is generating/);
    assert.equal(db.getSession('fork'), null);
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('lossless plan fork preserves exact requirements and remaps source message ids', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-e-plan-'));
  try {
    const store = new LosslessPlanStore(dir);
    const prompt = ['# Phase one','Keep the first exact requirement.','# Phase two','Keep the second exact requirement.','# Phase three','Keep the third exact requirement.'].join('\n');
    const source = await store.capture({ sessionID: 'source', messageID: 'u1', prompt, agent: 'plan' });
    assert.ok(source);
    const forked = await store.fork('source', 'fork', { u1: 'fork-u1' });
    assert.equal(forked.sessionID, 'fork');
    assert.equal(forked.sources[0].prompt, prompt);
    assert.equal(forked.sources[0].messageID, 'fork-u1');
    assert.equal(forked.phases.every((phase) => phase.sourceMessageID === 'fork-u1'), true);
    assert.deepEqual(forked.phases.map((phase) => phase.text), source.phases.map((phase) => phase.text));
    assert.equal((await store.get('source')).sources[0].messageID, 'u1');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('status and doctor aggregate independent authorities without exposing provider secrets or endpoint', async () => {
  const calls = [];
  const call = async (method) => {
    calls.push(method);
    switch (method) {
      case 'health': return { ok: true, activeRuns: 1 };
      case 'project.list': return [{ id: 'p1', missing: false }];
      case 'session.list': return [{ id: 's1', lastStatus: 'complete' }];
      case 'permission.list': return [];
      case 'cognitive.status': return { orchestratorEnabled: true, backgroundPaused: false, tst: { configured: false, connected: false }, roles: { foreground: 'primary' } };
      default: throw new Error(`unexpected ${method}`);
    }
  };
  const status = await buildRuntimeStatus({ call, providerConfig, version: 'test' });
  assert.equal(status.ok, true);
  assert.equal(status.provider.primary.modelID, 'primary-model');
  assert.equal(status.provider.secondary.modelID, 'secondary-model');
  assert.equal(JSON.stringify(status).includes('sk-must-remain-local'), false);
  assert.equal(JSON.stringify(status).includes('example.invalid'), false);
  const doctor = await buildRuntimeDoctor({ call, providerConfig, version: 'test' });
  assert.equal(doctor.ok, true);
  assert.equal(doctor.checks.find((item) => item.id === 'tst').status, 'warning');
  assert.deepEqual(new Set(calls), new Set(['health','project.list','session.list','permission.list','cognitive.status']));
});

test('Remote status/doctor stay read-scoped and use host-local provider configuration', async () => {
  assert.equal(scopeForCommand('status'), 'session.read');
  assert.equal(scopeForCommand('doctor'), 'session.read');
  const call = async (method) => {
    switch (method) {
      case 'health': return { ok: true, activeRuns: 0 };
      case 'project.list': return [];
      case 'session.list': return [];
      case 'permission.list': return [];
      case 'cognitive.status': return { orchestratorEnabled: false, backgroundPaused: false, tst: { configured: false, connected: false }, roles: {} };
      default: throw new Error(`unexpected ${method}`);
    }
  };
  const adapter = new RemoteCommandAdapter({ call, identity: { hostId: 'host', deviceName: 'Laptop' }, providerConfig });
  const actor = { deviceID: 'viewer' };
  const status = await adapter.execute(actor, 'status');
  const doctor = await adapter.execute(actor, 'doctor');
  assert.equal(status.version, '0.8.0-alpha.1');
  assert.equal(doctor.ok, true);
  assert.equal(JSON.stringify({ status, doctor }).includes('sk-must-remain-local'), false);
  assert.equal(JSON.stringify({ status, doctor }).includes('example.invalid'), false);
});
