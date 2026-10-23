import { createStreamingMarkdownRenderer, renderMarkdownBlocks } from './markdown';

const streams = new Map<number, ReturnType<typeof createStreamingMarkdownRenderer>>();

self.addEventListener('message', ({ data }: MessageEvent) => {
  if (data.type === 'release') { streams.delete(data.channel); return; }
  const { channel, content, streaming } = data;
  try {
    let rendered;
    if (streaming) {
      let render = streams.get(channel);
      if (!render) { render = createStreamingMarkdownRenderer(); streams.set(channel, render); }
      rendered = render(content);
    } else {
      streams.delete(channel);
      rendered = { blocks: renderMarkdownBlocks(content), tail: '' };
    }
    self.postMessage({ channel, content, streaming, rendered });
  } catch {
    self.postMessage({ channel, error: true });
  }
});
