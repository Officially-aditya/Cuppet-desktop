import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationDatabase } from '../src/runtime/database.mjs';
import { ToolRuntime } from '../src/runtime/tool-runtime.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cuppet-tool-activity-'));
  const db = new ConversationDatabase(join(dir, 'conversation.sqlite'));
  db.createSession({ id: 'session-1', title: 'Activity memory', now: 100 });
  db.appendMessage({ id: 'user-1', sessionId: 'session-1', role: 'user', content: 'Inspect the project', now: 101 });
  db.appendMessage({ id: 'assistant-1', sessionId: 'session-1', role: 'assistant', content: '', status: 'streaming', now: 102 });
  const toolRuntime = new ToolRuntime({
    tst: { configured: false },
    planStore: { async toolResult() { return null; } },
    permissions: { async authorize() { return { source: 'test' }; }, close() {} },
    db,
  });
  return { dir, db, toolRuntime };
}

test('tool executions are associated with the assistant message and legacy rows fall back to its time window', () => {
  const { dir, db } = fixture();
  try {
    db.createToolExecution({ id: 'tool-exact', sessionId: 'session-1', messageId: 'assistant-1', callId: 'call-1', toolName: 'tst_read', argumentsJson: '{"path":"src/app.js"}', now: 103 });
    db.finishToolExecution('tool-exact', { status: 'complete', output: 'exact output', now: 104 });
    assert.equal(db.getToolExecution('tool-exact').messageId, 'assistant-1');
    assert.deepEqual(db.listMessageToolExecutions('session-1', 'assistant-1').map((row) => row.id), ['tool-exact']);

    db.appendMessage({ id: 'user-2', sessionId: 'session-1', role: 'user', content: 'next', now: 200 });
    db.appendMessage({ id: 'assistant-2', sessionId: 'session-1', role: 'assistant', content: '', status: 'streaming', now: 201 });
    db.createToolExecution({ id: 'tool-legacy', sessionId: 'session-1', callId: 'call-2', toolName: 'bash', argumentsJson: '{"command":"pwd"}', now: 202 });
    db.finishToolExecution('tool-legacy', { status: 'complete', output: '/workspace', now: 203 });
    db.updateMessage('assistant-2', { status: 'complete', now: 204 });
    assert.deepEqual(db.listMessageToolExecutions('session-1', 'assistant-2').map((row) => row.id), ['tool-legacy']);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cuppet_memory_search inspects stored tool activity and supports offset reads', async () => {
  const { dir, db, toolRuntime } = fixture();
  try {
    db.createToolExecution({ id: 'tool-read', sessionId: 'session-1', messageId: 'assistant-1', callId: 'call-read', toolName: 'tst_read', argumentsJson: '{"path":"src/app.js"}', now: 103 });
    db.finishToolExecution('tool-read', { status: 'complete', output: 'FILE src/app.js\n0123456789', now: 104 });
    db.createToolExecution({ id: 'tool-plan', sessionId: 'session-1', messageId: 'assistant-1', callId: 'call-plan', toolName: 'cuppet_plan', argumentsJson: '{"action":"phase","phaseID":"P1"}', now: 105 });
    db.finishToolExecution('tool-plan', { status: 'complete', output: 'PHASE PLAN CONTENT', now: 106 });
    db.appendMessageActivity({ sessionId: 'session-1', messageId: 'assistant-1', source: 'execution', activity: { type: 'tool.started', tool: 'tst_read' }, now: 107 });

    const outputs = [];
    const requests = [
      { source: 'activity' },
      { source: 'activity', query: 'phaseID' },
      { tool_execution_id: 'tool-read', offset: 5, max_chars: 4 },
      { source: 'activity', include_activities: true },
      { tool_execution_id: 'tool-read', include_activities: true },
    ];
    const adapter = {
      async stream(_messages, { executeTool }) {
        for (const args of requests) {
          const result = await executeTool({ id: `memory-${outputs.length}`, name: 'cuppet_memory_search', arguments: JSON.stringify(args) });
          assert.equal(result.success, true);
          outputs.push(result.output);
        }
        return { text: '', toolCalls: [] };
      },
    };
    await toolRuntime.run({ adapter, messages: [{ role: 'user', content: 'recall the tool result' }], sessionId: 'session-1', signal: new AbortController().signal, onDelta: async () => {} });

    const listing = JSON.parse(outputs[0].split('\n').slice(1).join('\n'));
    assert.equal(listing.message.message_id, 'assistant-1');
    assert.equal(listing.tools.length, 2);
    assert.equal(listing.tools[0].tool_execution_id, 'tool-read');
    assert.equal(listing.tools[0].tool, 'tst_read');
    assert.equal(listing.tools[0].message_id, 'assistant-1');
    assert.equal(listing.tools[0].arguments_json, '{"path":"src/app.js"}');
    assert.equal(listing.tools[0].arguments_truncated, false);
    assert.equal(listing.tools[0].updated_at, 104);
    assert.equal(listing.tools[0].matched, null);
    assert.match(listing.tools[0].content, /FILE src\/app\.js/);
    assert.equal(listing.activities, undefined);

    const matched = JSON.parse(outputs[1].split('\n').slice(1).join('\n'));
    assert.equal(matched.tools.length, 1);
    assert.equal(matched.tools[0].tool_execution_id, 'tool-plan');
    assert.equal(matched.tools[0].matched, 'arguments');
    assert.match(matched.tools[0].arguments_json, /phaseID/);
    assert.equal(matched.tools[0].content, 'PHASE PLAN CONTENT');

    const exact = JSON.parse(outputs[2].split('\n').slice(1).join('\n'));
    assert.equal(exact.tool_execution_id, 'tool-read');
    assert.equal(exact.offset, 5);
    assert.equal(exact.content, 'src/');
    assert.equal(exact.next_offset, 9);
    assert.equal(exact.arguments_json, '{"path":"src/app.js"}');
    assert.equal(exact.updated_at, 104);
    assert.equal(exact.matched, null);

    const withActivities = JSON.parse(outputs[3].split('\n').slice(1).join('\n'));
    assert.equal(withActivities.activities.length, 1);
    assert.equal(withActivities.activities[0].source, 'execution');
    assert.equal(withActivities.activities[0].activity.type, 'tool.started');

    const exactWithActivities = JSON.parse(outputs[4].split('\n').slice(1).join('\n'));
    assert.equal(exactWithActivities.tool_execution_id, 'tool-read');
    assert.equal(exactWithActivities.activities.length, 1);
    assert.equal(exactWithActivities.activities[0].activity.type, 'tool.started');
  } finally {
    await toolRuntime.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
