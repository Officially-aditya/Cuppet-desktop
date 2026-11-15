// A tiny stdio MCP server for tests. Behaviour is selected with FAKE_MCP_MODE (comma separated):
//   crash-on-start   write to stderr and exit(3) before answering initialize
//   no-tools         do not advertise the tools capability
//   old-protocol     answer initialize with protocol 2024-11-05
//   bad-protocol     answer initialize with a protocol Cuppet does not support
//   hang-start       never answer initialize
//   slow-start       answer initialize only after FAKE_MCP_DELAY_MS (default 400), like a wrapper still downloading the server
//   many-tools       list 130 tools across several pages
//   long-names       list tools with very long and colliding names
//   linger           keep running after stdin closes, so only a signal can stop it
//   probe-client     after initialize, send the client a ping and an unsupported request and log its replies to stderr
import { createInterface } from 'node:readline';

const modes = new Set(String(process.env.FAKE_MCP_MODE || '').split(',').filter(Boolean));
const write = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);

if (modes.has('crash-on-start')) {
  process.stderr.write(`fatal: cannot start (secret=${process.env.FAKE_SECRET ?? ''})\n`);
  process.exit(3);
}

let tools = [
  { name: 'echo', description: 'Echo the text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } },
  { name: 'write note', description: 'Has a space in its name', inputSchema: { type: 'object' } },
  { name: 'env', description: 'Report environment variable names', inputSchema: { type: 'object', properties: {} } },
  { name: 'fail', description: 'Always reports isError', inputSchema: { type: 'object', properties: {} } },
  { name: 'sleep', description: 'Wait for a long time', inputSchema: { type: 'object', properties: {} } },
  { name: 'image', description: 'Return an image', inputSchema: { type: 'object', properties: {} } },
];
if (modes.has('many-tools')) tools = Array.from({ length: 130 }, (_, index) => ({ name: `tool_${index}`, description: `Tool ${index}`, inputSchema: { type: 'object', properties: {} } }));
if (modes.has('long-names')) {
  const long = 'a'.repeat(80);
  tools = [{ name: `${long}1`, inputSchema: { type: 'object' } }, { name: `${long}2`, inputSchema: { type: 'object' } }, { name: 'x y', inputSchema: { type: 'object' } }, { name: 'x_y', inputSchema: { type: 'object' } }];
}

if (modes.has('linger')) setInterval(() => {}, 60_000);

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', async (line) => {
  const message = JSON.parse(line);
  if (message.method === 'notifications/cancelled') { process.stderr.write(`cancelled:${message.params.requestId}\n`); return; }
  if (!message.method && Object.hasOwn(message, 'id')) { process.stderr.write(`reply:${message.id}:${JSON.stringify(message.result ?? message.error)}\n`); return; }
  if (!Object.hasOwn(message, 'id')) return;
  switch (message.method) {
    case 'initialize': {
      if (modes.has('hang-start')) return;
      if (modes.has('slow-start')) await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_MCP_DELAY_MS || 400)));
      const protocolVersion = modes.has('bad-protocol') ? '1999-01-01' : modes.has('old-protocol') ? '2024-11-05' : message.params.protocolVersion;
      write({ id: message.id, result: { protocolVersion, capabilities: modes.has('no-tools') ? {} : { tools: { listChanged: true } }, serverInfo: { name: 'fake-mcp', version: '1.0.0' } } });
      if (modes.has('probe-client')) { write({ id: 's1', method: 'ping' }); write({ id: 's2', method: 'sampling/createMessage', params: {} }); }
      return;
    }
    case 'tools/list': {
      const cursor = Number(message.params?.cursor || 0);
      const page = tools.slice(cursor, cursor + 50);
      write({ id: message.id, result: { tools: page, ...(cursor + 50 < tools.length ? { nextCursor: String(cursor + 50) } : {}) } });
      return;
    }
    case 'tools/call': {
      const { name, arguments: args } = message.params;
      if (name === 'echo') write({ id: message.id, result: { content: [{ type: 'text', text: `echo:${args.text}` }] } });
      else if (name === 'env') write({ id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ names: Object.keys(process.env).sort(), value: process.env.FAKE_TOKEN ?? null, cwd: process.cwd(), pid: process.pid }) }] } });
      else if (name === 'fail') write({ id: message.id, result: { isError: true, content: [{ type: 'text', text: 'it broke' }] } });
      else if (name === 'sleep') return;
      else if (name === 'image') write({ id: message.id, result: { content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }, { type: 'text', text: 'pic' }] } });
      else if (name === 'write note') {
        write({ id: message.id, result: { content: [{ type: 'text', text: 'noted' }] } });
        write({ method: 'notifications/tools/list_changed' });
        tools = [...tools, { name: 'added_later', description: 'Appears after a list_changed notification', inputSchema: { type: 'object' } }];
      } else write({ id: message.id, error: { code: -32602, message: `Unknown tool: ${name}` } });
      return;
    }
    case 'ping': write({ id: message.id, result: {} }); return;
    default: write({ id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
});
