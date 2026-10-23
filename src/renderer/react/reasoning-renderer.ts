export type ReasoningMarkdown = { blocks: string[]; tail: string };
export type ReasoningRenderResult = { content: string; streaming: boolean; rendered: ReasoningMarkdown };
type RenderRequest = { channel: number; content: string; streaming: boolean };
type RenderReply = RenderRequest & { rendered: ReasoningMarkdown; error?: boolean };
type PendingRenderer = {
  busy: boolean;
  pending: RenderRequest | null;
  receive: (result: ReasoningRenderResult) => void;
  fail: () => void;
};

let worker: Worker | null = null;
let nextChannel = 0;
const clients = new Map<number, PendingRenderer>();

function send(client: PendingRenderer) {
  if (client.busy || !client.pending || !worker) return;
  client.busy = true;
  worker.postMessage(client.pending);
  client.pending = null;
}

function failWorker() {
  worker?.terminate();
  worker = null;
  const failed = [...clients.values()];
  clients.clear();
  for (const client of failed) client.fail();
}

export function createReasoningRenderer(receive: PendingRenderer['receive'], fail: () => void) {
  if (!worker) {
    worker = new Worker(new URL('./reasoning-markdown.worker.ts', import.meta.url), { type: 'module' });
    const created = worker;
    worker.onmessage = ({ data }: MessageEvent<RenderReply>) => {
      const client = clients.get(data.channel);
      if (!client) return;
      client.busy = false;
      if (data.error) client.fail();
      else client.receive(data);
      if (clients.has(data.channel)) send(client);
    };
    worker.onerror = () => { if (worker === created) failWorker(); };
    worker.onmessageerror = () => { if (worker === created) failWorker(); };
  }
  const channel = ++nextChannel;
  const client: PendingRenderer = { busy: false, pending: null, receive, fail };
  clients.set(channel, client);
  return {
    render(content: string, streaming: boolean) {
      if (!clients.has(channel)) return;
      // Only one render per thought can be in flight. Streaming replaces the queued request.
      client.pending = { channel, content, streaming };
      send(client);
    },
    dispose() {
      clients.delete(channel);
      worker?.postMessage({ type: 'release', channel });
      if (!clients.size) { worker?.terminate(); worker = null; }
    },
  };
}
