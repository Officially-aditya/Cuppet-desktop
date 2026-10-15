import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const rl = createInterface({ input: process.stdin });
const write = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const options = value => [{ id: 'model', type: 'select', name: 'Model', category: 'model', currentValue: value, options: [{ value: 'model-a', name: 'A' }, { value: 'model-b', name: 'B' }] }];
let model = 'model-a';
let pendingPrompt;
rl.on('line', line => {
  const m = JSON.parse(line);
  if (process.env.CLEANUP_TEST_LOG) appendFileSync(process.env.CLEANUP_TEST_LOG, JSON.stringify({ method: m.method, sessionId: m.params?.sessionId }) + '\n');
  const reply = result => write({ jsonrpc: '2.0', id: m.id, result });
  if (m.method === 'initialize') return reply({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {}, delete: {} } }, authMethods: [] });
  if (m.method === 'session/new') {
    const sessionId = randomUUID();
    const saved = JSON.parse(readFileSync(process.env.CLEANUP_TEST_DB, 'utf8'));
    saved.push(sessionId); writeFileSync(process.env.CLEANUP_TEST_DB, JSON.stringify(saved));
    return reply({ sessionId, configOptions: options(model) });
  }
  if (m.method === 'session/delete') {
    if (process.env.CLEANUP_TEST_FAIL === '1') return write({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'temporary cleanup failure' } });
    const saved = JSON.parse(readFileSync(process.env.CLEANUP_TEST_DB, 'utf8'));
    writeFileSync(process.env.CLEANUP_TEST_DB, JSON.stringify(saved.filter(id => id !== m.params.sessionId)));
    return reply({});
  }
  if (m.method === 'session/set_config_option') { model = m.params.value; return reply({ configOptions: options(model) }); }
  if (m.method === 'session/close') return reply({});
  if (m.method === 'session/cancel' && pendingPrompt) {
    write({ jsonrpc: '2.0', id: pendingPrompt, result: { stopReason: 'cancelled' } });
    pendingPrompt = null;
    return;
  }
  if (m.method === 'session/prompt') {
    if (process.env.CLEANUP_TEST_PROMPT === 'error') return write({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'provider prompt failed' } });
    if (process.env.CLEANUP_TEST_PROMPT === 'cancel') { pendingPrompt = m.id; return; }
    write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: m.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } } } });
    return reply({ stopReason: 'end_turn' });
  }
  if (m.id !== undefined) write({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
});
rl.on('close', () => process.exit(0));
