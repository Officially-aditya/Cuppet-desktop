import { createInterface } from 'node:readline';

let tools = [{ name: 'browser_status', description: 'Test browser status', inputSchema: { type: 'object', properties: {} } }];
let listError = false;
let listDelay = 0;
let listRequests = 0;
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const write = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);

input.on('line', (line) => {
  const message = JSON.parse(line);
  if (!Object.hasOwn(message, 'id')) return;
  if (message.method === 'initialize') {
    write({ id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fake-browser-control', version: '1' } } });
  } else if (message.method === 'tools/list') {
    listRequests += 1;
    const cursor = Number(message.params?.cursor || 0);
    const result = { tools: tools.slice(cursor, cursor + 2), ...(cursor + 2 < tools.length ? { nextCursor: String(cursor + 2) } : {}) };
    const response = listError
      ? { id: message.id, error: { code: -32603, message: 'Test tools/list failure' } }
      : { id: message.id, result };
    setTimeout(() => write(response), listDelay);
  } else if (message.method === 'tools/call') {
    const args = message.params.arguments;
    if (Array.isArray(args.tools)) tools = args.tools;
    if (typeof args.listError === 'boolean') listError = args.listError;
    if (typeof args.listDelay === 'number') listDelay = args.listDelay;
    write({ id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ listRequests, pid: process.pid }) }] } });
    if (args.notify) write({ method: 'notifications/tools/list_changed' });
  }
});
