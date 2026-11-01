// Test-only SDK server: Content-Length frames, fragmented writes and explicit failures.
let buffer = Buffer.alloc(0);
const scenario = process.argv[2] || 'normal';
const send = (message) => {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.from('Content-Length: ' + body.length + '\r\n\r\n');
  // Exercise arbitrary stream boundaries, including inside multi-byte JSON strings.
  const frame = Buffer.concat([header, body]);
  process.stdout.write(frame.subarray(0, 7));
  setTimeout(() => {
    process.stdout.write(frame.subarray(7, header.length + 2));
    setTimeout(() => process.stdout.write(frame.subarray(header.length + 2)), 1);
  }, 1);
};
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const marker = buffer.indexOf('\r\n\r\n');
    if (marker === -1) break;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, marker).toString())[1]);
    if (buffer.length < marker + 4 + length) break;
    const request = JSON.parse(buffer.subarray(marker + 4, marker + 4 + length).toString());
    buffer = buffer.subarray(marker + 4 + length);
    const { id, method } = request;
    if (method === 'connect') {
      if (scenario === 'legacy') send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unhandled method connect private-token' } });
      else send({ jsonrpc: '2.0', id, result: { protocolVersion: scenario === 'incompatible' ? 99 : 3 } });
    } else if (method === 'ping') send({ jsonrpc: '2.0', id, result: { protocolVersion: 2 } });
    else if (method === 'auth.getStatus') send({ jsonrpc: '2.0', id, result: { isAuthenticated: true } });
    else if (method === 'account.getQuota') {
      if (scenario === 'hang') continue;
      if (scenario === 'exit') process.exit(2);
      if (scenario === 'error') send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'provider private-token must not reach renderer' } });
      else send({ jsonrpc: '2.0', id, result: { quotaSnapshots: {
        premium_interactions: { entitlementRequests: 300, usedRequests: 75, remainingPercentage: 75, resetDate: '2030-02-01' },
        'crédits': { remainingPercentage: 50 },
      } } });
    } else send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unexpected request: ' + method } });
  }
});
process.stdin.on('end', () => process.exit(0));
