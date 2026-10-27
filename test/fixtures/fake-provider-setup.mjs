import { createInterface } from 'node:readline';
import { existsSync, writeFileSync } from 'node:fs';

const authFile = process.env.TEST_SETUP_AUTH_FILE;
const mode = process.env.TEST_SETUP_METHOD || 'terminal';
const signedIn = () => Boolean(authFile && existsSync(authFile));
const signIn = () => { if (authFile) writeFileSync(authFile, 'authenticated'); };
if (process.argv.includes('--login')) {
  if (!process.stdin.isTTY) throw new Error('Login requires a real terminal');
  process.stdout.write('Paste sign-in code here > ');
  createInterface({ input: process.stdin }).on('line', (line) => {
    if (line.trim() === '123456') { signIn(); process.exit(0); }
    process.stdout.write('Try again > ');
  });
} else {
  const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  let authenticationRequest;
  let authenticated = false;
  createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      let authMethods;
      if (mode === 'terminal') authMethods = message.params.clientCapabilities.auth?.terminal
        ? [{ id: 'terminal-login', name: 'Sign in', type: 'terminal', args: ['--login'] }] : [];
      else if (mode === 'grok') authMethods = signedIn() ? [{ id: 'cached_token' }] : [{ id: 'grok.com' }];
      else if (mode === 'opencode') authMethods = [{ id: 'opencode-login' }];
      else authMethods = [{ id: 'browser-auth' }];
      write({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods } });
    } else if (message.method === 'authenticate') {
      if (mode === 'terminal' || mode === 'opencode') throw new Error('Terminal authentication must not call authenticate');
      if (message.params.methodId === 'cached_token') {
        authenticated = signedIn();
        write({ jsonrpc: '2.0', id: message.id, result: {} });
      } else if (mode === 'unverified' || mode === 'browser-noop') {
        write({ jsonrpc: '2.0', id: message.id, result: {} });
      } else {
        authenticationRequest = message.id;
        write({ jsonrpc: '2.0', id: 'browser-consent', method: 'elicitation/create', params: {
          mode: 'url', requestId: message.id, elicitationId: 'setup', url: 'https://example.com/provider-sign-in',
        } });
      }
    } else if (message.id === 'browser-consent') {
      if (message.result?.action === 'accept') {
        signIn(); authenticated = true;
        write({ jsonrpc: '2.0', id: authenticationRequest, result: {} });
      } else write({ jsonrpc: '2.0', id: authenticationRequest, error: { code: -32000, message: 'Authentication required' } });
    } else if (message.method === 'session/new') {
      if (!signedIn() && !authenticated && mode !== 'unverified') {
        write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Missing API key' } });
      } else write({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'setup-session', configOptions: [] } });
    }
  });
}
