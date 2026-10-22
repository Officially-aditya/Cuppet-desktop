import { PermissionBroker } from '../src/runtime/permissions.mjs';
import { assertProviderRuntime } from '../src/runtime/providers/runtime-contract.mjs';
import type { MessageDeltaEvent, PermissionEvent, ProviderRuntime, RuntimeEvent } from '../src/shared/runtime-contracts';
import type { CuppetApi } from '../src/renderer/ipc-api';

const broker = new PermissionBroker({
  emit(event) {
    if (event.type === 'permission.requested') event.request.resources.map((path) => path.toUpperCase());
    else event.allowed satisfies boolean;
  },
});
void broker.authorize({ sessionId: 's', action: 'read', resources: ['app.js'], signal: new AbortController().signal });
broker.setAuto('s', 'full');
broker.reply('request', 'once');
// @ts-expect-error permission replies use the canonical three choices
broker.reply('request', 'allow');
// @ts-expect-error session permission modes are boolean or full
broker.setAuto('s', 1);
// @ts-expect-error authorization resources must be a collection
void broker.authorize({ sessionId: 's', action: 'read', resources: 'app.js' });
// @ts-expect-error permission emitters must accept an event
new PermissionBroker({ emit: (event: number) => {} });

const delta: MessageDeltaEvent = { type: 'message.delta', sessionId: 's', messageId: 'm', delta: 'hello', seq: 5 };
// @ts-expect-error streaming events require a numeric resync cursor
const invalidDelta: MessageDeltaEvent = { ...delta, seq: '5' };
// @ts-expect-error permission resolutions require the exact reply vocabulary
const invalidPermission: PermissionEvent = { type: 'permission.resolved', sessionId: 's', requestId: 'p', reply: 'allow', allowed: true };
const event: RuntimeEvent = delta;
if (event.type === 'message.delta') event.seq satisfies number;
const runtime: ProviderRuntime = {
  async start() {},
  capabilities() { return { models: [{ id: 'model' }] }; },
  async runTurn(_input, hooks) { await hooks?.onText?.('hello'); return { text: 'hello' }; },
  cancel() {},
  close() {},
};
assertProviderRuntime(runtime).runTurn({ messages: [{ role: 'user', content: 'hello' }] });
// @ts-expect-error providers must implement every lifecycle operation
const invalidRuntime: ProviderRuntime = { start: async () => {}, capabilities: () => ({}) };

declare const api: CuppetApi;
api.terminal.resize('terminal', 80, 24);
api.sessions.editedFiles('s');
// @ts-expect-error generated IPC arguments preserve terminal dimensions
api.terminal.resize('terminal', '80', 24);
// @ts-expect-error generated IPC permission replies share runtime vocabulary
api.permissions.reply('request', 'allow');
