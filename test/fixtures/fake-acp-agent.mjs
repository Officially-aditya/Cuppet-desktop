import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
let promptRequest = null;
let cwd = process.cwd();
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    write({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    return;
  }
  if (message.method === 'session/new') {
    cwd = message.params.cwd;
    write({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'fake-session' } });
    return;
  }
  if (message.method === 'session/prompt') {
    promptRequest = message.id;
    write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fake-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Working. ' } } } });
    write({ jsonrpc: '2.0', id: 'perm-1', method: 'session/request_permission', params: { sessionId: 'fake-session', toolCall: { toolCallId: 'call-1', kind: 'edit', title: 'Edit sample.txt', locations: [{ path: `${cwd}/sample.txt` }] }, options: [{ optionId: 'yes', name: 'Yes', kind: 'allow_once' }, { optionId: 'no', name: 'No', kind: 'reject_once' }] } });
    return;
  }
  if (message.id === 'perm-1' && message.result?.outcome?.optionId === 'yes') {
    write({ jsonrpc: '2.0', id: 'read-1', method: 'fs/read_text_file', params: { sessionId: 'fake-session', path: `${cwd}/sample.txt` } });
    return;
  }
  if (message.id === 'read-1' && message.result?.content === 'hello') {
    write({ jsonrpc: '2.0', id: 'write-1', method: 'fs/write_text_file', params: { sessionId: 'fake-session', path: `${cwd}/sample.txt`, content: 'hello world' } });
    return;
  }
  if (message.id === 'write-1' && message.result) {
    write({ jsonrpc: '2.0', id: 'term-1', method: 'terminal/create', params: { sessionId: 'fake-session', command: 'printf', args: ['ok'] } });
    return;
  }
  if (message.id === 'term-1' && message.result?.terminalId) {
    write({ jsonrpc: '2.0', id: 'wait-1', method: 'terminal/wait_for_exit', params: { sessionId: 'fake-session', terminalId: message.result.terminalId } });
    return;
  }
  if (message.id === 'wait-1') {
    write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fake-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } } } });
    write({ jsonrpc: '2.0', id: promptRequest, result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } } });
  }
});
