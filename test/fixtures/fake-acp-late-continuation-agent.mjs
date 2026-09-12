import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const sessionId = 'late-continuation-session';

rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    write({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    return;
  }
  if (message.method === 'session/new') {
    write({ jsonrpc: '2.0', id: message.id, result: { sessionId } });
    return;
  }
  if (message.method === 'session/prompt') {
    write({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'background-1',
          status: 'completed',
          kind: 'execute',
          title: 'Run attached background command',
          rawInput: { command: 'sleep 12; printf ACP_SHELL_DONE', mode: 'async' },
        },
      },
    });
    write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'WAITING' } } } });
    write({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
    setTimeout(() => {
      write({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'read-background-1',
            status: 'completed',
            kind: 'read',
            title: 'Read attached background output',
            rawInput: { command: 'read_bash background-1' },
          },
        },
      });
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' FINAL_DONE' } } } });
    }, 50);
  }
});
