import { createInterface } from 'node:readline';

const write = (value) => process.stdout.write(JSON.stringify(value) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    write({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, authMethods: [{ id: 'oauth-personal' }] } });
  } else if (message.method === 'authenticate') {
    const output = process.env.FAKE_AUTH_OUTPUT === 'stderr' ? process.stderr : process.stdout;
    const prompt = 'Open the following link to authenticate the ACP server: https://accounts.google.com/test\n';
    output.write(prompt.slice(0, 20));
    setTimeout(() => output.write(prompt.slice(20)), 5);
    if (process.env.FAKE_AUTH_COMPLETE === '1') setTimeout(() => write({ jsonrpc: '2.0', id: message.id, result: {} }), 20);
  } else if (message.method === 'session/new') {
    write({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'authenticated' } });
  }
});
