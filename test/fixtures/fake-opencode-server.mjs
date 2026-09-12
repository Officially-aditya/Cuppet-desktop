import { createServer } from 'node:http';

const args = process.argv.slice(2);
if (args[0] === 'models') {
  if (!args.includes('--verbose')) {
    process.stderr.write('expected --verbose model discovery\n');
    process.exit(5);
  }
  process.stdout.write([
    'anthropic/test-model',
    JSON.stringify({
      id: 'test-model',
      name: 'Anthropic Test Model',
      family: 'claude-test',
      limit: { context: 200000, output: 64000 },
      variants: { low: {}, medium: {}, high: {} },
    }, null, 2),
    'openai/test-model',
    JSON.stringify({
      id: 'test-model',
      name: 'OpenAI Test Model',
      family: 'gpt-test',
      limit: { context: 128000, output: 32000 },
      variants: { minimal: {}, high: {} },
    }, null, 2),
    '',
  ].join('\n'));
  process.exit(0);
}

if (args[0] !== 'serve') {
  process.stderr.write(`unexpected fake OpenCode command: ${args.join(' ')}\n`);
  process.exit(2);
}

const portIndex = args.findIndex((item) => item === '--port' || item.startsWith('--port='));
const port = portIndex < 0
  ? 0
  : args[portIndex].includes('=')
    ? Number(args[portIndex].split('=')[1])
    : Number(args[portIndex + 1]);
if (!Number.isInteger(port) || port <= 0) process.exit(3);

const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
const mcp = config?.mcp?.['cuppet-runtime'];
if (config?.permission?.['*'] !== 'deny' || mcp?.type !== 'local' || !Array.isArray(mcp?.command) || !mcp.command.length) {
  process.stderr.write('Cuppet OpenCode isolation config was not installed\n');
  process.exit(4);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
  if (request.method === 'GET' && url.pathname === '/global/health') {
    return json(response, 200, { healthy: true, version: '1.18.5' });
  }
  if (request.method === 'POST' && url.pathname === '/session') {
    await body(request);
    return json(response, 200, { id: 'ses_test' });
  }
  if (request.method === 'POST' && url.pathname === '/session/ses_test/message') {
    const payload = await body(request);
    if (payload?.model?.providerID !== 'anthropic' || payload?.model?.modelID !== 'test-model') {
      return json(response, 400, { error: 'model was not forwarded' });
    }
    if (payload?.variant !== 'high') {
      return json(response, 400, { error: 'variant was not forwarded' });
    }
    if (payload?.agent !== 'build' || payload?.tools?.bash !== false || payload?.tools?.edit !== false || !Array.isArray(payload?.parts)) {
      return json(response, 400, { error: 'Cuppet execution isolation was not forwarded' });
    }
    if (!String(payload?.system || '').includes('Cuppet')) {
      return json(response, 400, { error: 'Cuppet runtime instructions missing' });
    }
    return json(response, 200, {
      info: { tokens: { input: 3, output: 2, reasoning: 1, cache: { read: 1 } } },
      parts: [{ type: 'text', text: 'OpenCode ready.' }],
    });
  }
  return json(response, 404, { error: `unexpected ${request.method} ${url.pathname}` });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`opencode server listening on http://127.0.0.1:${port}\n`);
});

const close = () => server.close(() => process.exit(0));
process.on('SIGTERM', close);
process.on('SIGINT', close);

function json(response, status, value) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(value));
}
function body(request) {
  return new Promise((resolveBody, rejectBody) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { raw += chunk; if (raw.length > 2_000_000) rejectBody(new Error('body too large')); });
    request.on('end', () => {
      try { resolveBody(raw ? JSON.parse(raw) : {}); }
      catch (error) { rejectBody(error); }
    });
    request.on('error', rejectBody);
  });
}
