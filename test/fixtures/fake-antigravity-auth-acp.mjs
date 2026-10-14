import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

const write = (value) => process.stdout.write(JSON.stringify(value) + '\n');
let authenticated = process.env.FAKE_AUTHENTICATED === '1';
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (process.env.FAKE_ACP_TRACE_PATH) appendFileSync(process.env.FAKE_ACP_TRACE_PATH, message.method + '\n');
  if (message.method === 'initialize') {
    write({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, authMethods: [{ id: 'oauth-personal' }] } });
  } else if (message.method === 'authenticate') {
    if (authenticated) {
      write({ jsonrpc: '2.0', id: message.id, result: {} });
      return;
    }
    const output = process.env.FAKE_AUTH_OUTPUT === 'stderr' ? process.stderr : process.stdout;
    const prompt = 'Open the following link to authenticate the ACP server: https://accounts.google.com/test\n';
    output.write(prompt.slice(0, 20));
    setTimeout(() => output.write(prompt.slice(20)), 5);
    if (process.env.FAKE_AUTH_DUPLICATE === '1') setTimeout(() => process.stderr.write(prompt), 10);
    if (process.env.FAKE_AUTH_COMPLETE === '1') setTimeout(() => {
      authenticated = true;
      write({ jsonrpc: '2.0', id: message.id, result: {} });
    }, 20);
  } else if (message.method === 'session/new') {
    write(authenticated
      ? { jsonrpc: '2.0', id: message.id, result: { sessionId: 'authenticated' } }
      : { jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Authentication required' } });
  }
});
