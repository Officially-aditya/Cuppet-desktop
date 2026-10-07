import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationDatabase } from '../src/runtime/database.mjs';
import { ProjectManager } from '../src/runtime/projects.mjs';
import { RemoteCommandAdapter } from '../src/runtime/remote/commands.mjs';
import { sessionProjection } from '../src/runtime/remote/session-projection.mjs';
import { encodeFrame, scopeForCommand } from '../src/runtime/remote/protocol.mjs';

function fixture() {
  const messages = Array.from({ length: 80 }, (_, i) => ({ id: `m${i + 1}`, sequence: i + 1,
    role: i % 2 === 0 ? 'user' : 'assistant', content: `Message ${i + 1} ` + 'text '.repeat(7000) }));
  const session = { id: 's1', projectId: 'p1', title: 'Large chat', messages,
    activities: Array.from({ length: 1000 }, (_, i) => ({ messageId: 'm80', sequence: i,
      activity: { type: 'activity.text.delta', text: 'duplicate stream text'.repeat(100) } })) };
  const calls = [];
  const call = async (method, params = {}, context) => {
    calls.push({ method, params, context });
    switch (method) {
      case 'session.list': return [{ id: 's1', projectId: 'p1', title: 'Large chat' },
        ...(params.projectId === 'p1' ? [] : [{ id: 's2', projectId: 'p2', title: 'Other chat' }])];
      case 'session.get': return session;
      case 'session.mode.get': return { mode: 'build' };
      case 'session.auto.get': return { enabled: false };
      case 'session.run.latest': return { id: 'run1', status: 'running' };
      case 'project.create-folder': return { id: 'p3', name: params.name, canonicalPath: params.path ?? '/tmp/New project' };
      default: throw new Error(`unexpected ${method}`);
    }
  };
  return { adapter: new RemoteCommandAdapter({ call, identity: { hostId: 'host_large', deviceName: 'Laptop' } }), calls };
}

test('resume is metadata-only and history loads four messages at a time below the frame limit', async () => {
  const { adapter, calls } = fixture();
  const actor = { deviceID: 'phone' };
  const summary = await adapter.execute(actor, 'session.resume', { sessionID: 's1' });
  assert.equal(summary.id, 's1');
  assert.equal(summary.messages, undefined);
  assert.equal(calls.some((call) => call.method === 'session.get'), false);
  const latest = await adapter.execute(actor, 'session.snapshot', { limit: 4 });
  assert.deepEqual(latest.session.messages.map((message) => message.sequence), [77, 78, 79, 80]);
  assert.equal(latest.history.hasMore, true);
  assert.equal(latest.history.beforeSequence, 77);
  assert.equal(latest.session.activities.length, 0, 'text deltas must not duplicate message content');
  assert.ok(Buffer.byteLength(encodeFrame({ version: 1, replyTo: 'snapshot', ok: true, result: latest })) < 512 * 1024);
  const earlier = await adapter.execute(actor, 'session.snapshot', { limit: 4, beforeSequence: latest.history.beforeSequence });
  assert.deepEqual(earlier.session.messages.map((message) => message.sequence), [73, 74, 75, 76]);
});

test('chat lists are scoped to the requested project and new project creation uses the desktop authority', async () => {
  const { adapter, calls } = fixture();
  const actor = { deviceID: 'phone' };
  const sessions = await adapter.execute(actor, 'session.list', { workspaceId: 'p1' });
  assert.deepEqual(sessions.map((session) => session.id), ['s1']);
  const created = await adapter.execute(actor, 'workspace.create', { name: 'New project', path: '/tmp/new-project' }, { id: 'create-project' });
  assert.equal(created.workspaceId, 'p3');
  assert.equal(created.name, 'New project');
  assert.equal(scopeForCommand('workspace.create'), 'session.write');
  const request = calls.find((call) => call.method === 'project.create-folder');
  assert.deepEqual(request.params, { name: 'New project', path: '/tmp/new-project' });
  assert.match(request.context.commandId, /^remote:/);
});

test('new project folders are registered on the desktop and an existing folder is never overwritten', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cuppet-remote-project-'));
  const db = new ConversationDatabase(join(dir, 'db.sqlite3'));
  const manager = new ProjectManager({ db, runCommand: async () => ({ ok: false, stdout: '', stderr: '' }) });
  const path = join(dir, 'My project');
  try {
    const project = await manager.createFolder({ id: 'p_new', name: 'My project', path });
    assert.equal(project.canonicalPath, await realpath(path));
    assert.equal(db.getProject('p_new').name, 'My project');
    assert.equal((await stat(path)).isDirectory(), true);
    await writeFile(join(path, 'existing.txt'), 'Keep this file');
    await assert.rejects(manager.createFolder({ id: 'p_duplicate', name: 'Duplicate', path }), { code: 'PROJECT_FOLDER_EXISTS' });
    assert.equal(await readFile(join(path, 'existing.txt'), 'utf8'), 'Keep this file');
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});


test('four-message pages count user and agent messages while omitting internal system markers', () => {
  const messages = [
    {id:'m1',sequence:1,role:'user',content:'first'},
    {id:'m2',sequence:2,role:'assistant',content:'reply'},
    {id:'m3',sequence:3,role:'user',content:'next'},
    {id:'m4',sequence:4,role:'assistant',content:'answer'},
    {id:'m5',sequence:5,role:'system',content:'internal routing marker'},
  ];
  const page = sessionProjection({id:'s1',title:'Chat',messages},{limit:4});
  assert.deepEqual(page.session.messages.map((message)=>message.role),['user','assistant','user','assistant']);
  assert.equal(page.history.hasMore,false);
});
