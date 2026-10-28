import { createConnection } from 'node:net';
import { pathToFileURL } from 'node:url';

// Loaded inside Cuppet's private OpenCode server. This uses OpenCode's own inbox
// API, so guidance reaches the active agent even when it is not calling tools.
export default {
  id: 'cuppet-steering',
  async setup({ session, options }) {
    const socket = createConnection(options.endpoint);
    socket.setEncoding('utf8');
    let buffer = '';
    let ready;
    let fail;
    const registered = new Promise((resolve, reject) => { ready = resolve; fail = reject; });
    const timer = setTimeout(() => { fail(new Error('Cuppet steering connection timed out')); socket.destroy(); }, 10_000);
    const write = (message) => { if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`); };
    socket.on('connect', () => write({ id: 'hello', method: 'hello', token: options.token }));
    socket.on('error', fail);
    socket.on('close', () => { clearTimeout(timer); fail(new Error('Cuppet steering connection closed')); });
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 40 * 1024 * 1024) { socket.destroy(); return; }
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { socket.destroy(); return; }
        if (message.id === 'hello') {
          if (message.error) { fail(new Error(message.error.message)); socket.destroy(); return; }
          write({ id: 'register', method: 'steering/register' });
        } else if (message.id === 'register') {
          clearTimeout(timer);
          if (message.error) { fail(new Error(message.error.message)); socket.destroy(); return; }
          ready();
        } else if (message.method === 'session.steer') {
          const { sessionId, text, attachments = [] } = message.params;
          const files = attachments.flatMap((attachment) => {
            const uri = attachment.dataUrl || (attachment.path ? pathToFileURL(attachment.path).href : '');
            return uri ? [{ uri, name: attachment.name }] : [];
          });
          void session.prompt({ sessionID: sessionId, text, files, delivery: 'steer' }).then(
            () => write({ id: message.id, result: { accepted: true } }),
            (error) => write({ id: message.id, error: { message: String(error?.message ?? error).slice(0, 1000) } }),
          );
        }
      }
    });
    await registered;
    return () => socket.destroy();
  },
};
