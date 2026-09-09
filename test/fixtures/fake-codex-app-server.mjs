import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let toolRequestSent = false;

lines.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }

  if (message.method === 'initialize' && message.id != null) {
    send({ id: message.id, result: { userAgent: 'fake-codex-app-server/1' } });
    return;
  }
  if (message.method === 'initialized') {
    if (!toolRequestSent) {
      toolRequestSent = true;
      send({ id: 900, method: 'item/tool/call', params: { callId: 'fake-call', turnId: 'fake-turn', tool: 'echo', arguments: { value: 'hello' } } });
    }
    return;
  }
  if (message.method === 'account/read' && message.id != null) {
    send({ id: message.id, result: { account: { type: 'chatgpt', email: 'fake@example.com', planType: 'plus' }, requiresOpenaiAuth: true } });
    return;
  }
  if (message.method === 'account/login/start' && message.id != null) {
    send({ id: message.id, result: { type: 'chatgpt', loginId: 'fake-login', authUrl: 'https://example.com/codex-login' } });
    setTimeout(() => send({ method: 'account/login/completed', params: { loginId: 'fake-login', success: true } }), 10);
    return;
  }
  if (message.id === 900 && Object.prototype.hasOwnProperty.call(message, 'result')) {
    send({ method: 'test/tool-response', params: message.result });
    return;
  }
  if (message.id != null) send({ id: message.id, result: {} });
});

function send(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
