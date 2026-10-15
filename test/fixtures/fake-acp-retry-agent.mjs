import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
const write = value => process.stdout.write(`${JSON.stringify(value)}\n`);
let timer;
let prompt;
const update = value => write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'retry-session', update: value } });
rl.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') write({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  if (message.method === 'session/new') write({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'retry-session' } });
  if (message.method === 'session/prompt') {
    prompt = message;
    const recover = JSON.stringify(message.params).includes('RECOVER');
    let attempt = 0;
    timer = setInterval(() => {
      attempt++;
      update({ sessionUpdate: 'session_info_update', _meta: { 'opencode/retry': { attempt, error: { type: 'provider.internal', status: 502, message: 'Endpoint is unavailable' } } } });
      if (recover && attempt >= Number(process.env.FAKE_ACP_RECOVER_AFTER || 1)) {
        clearInterval(timer);
        update({ sessionUpdate: 'session_info_update', _meta: { 'opencode/retry': null } });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Recovered.' } });
        write({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
      }
    }, 20);
  }
  if (message.method === 'session/cancel') {
    clearInterval(timer);
    write({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'cancelled' } });
  }
});
rl.on('close', () => { clearInterval(timer); process.exit(0); });
