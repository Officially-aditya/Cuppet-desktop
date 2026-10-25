import type { Attachment } from '../types';

const MAX_IMAGES = 12;
const MAX_DATA_LENGTH = 16 * 1024 * 1024;
const images = new Map<string, Attachment>();
const pending = new Map<string, Promise<Attachment>>();
let dataLength = 0;
const keyFor = (sessionId: string, messageId: string, index: number) => JSON.stringify([sessionId, messageId, index]);

export function cachedAttachment(sessionId: string, messageId: string, index: number) {
  const key = keyFor(sessionId, messageId, index);
  const image = images.get(key);
  if (image) { images.delete(key); images.set(key, image); }
  return image;
}

export async function loadAttachment(sessionId: string, messageId: string, index: number): Promise<Attachment> {
  const cached = cachedAttachment(sessionId, messageId, index);
  if (cached) return cached;
  const key = keyFor(sessionId, messageId, index);
  const existing = pending.get(key);
  if (existing) return existing;
  const request = window.cuppet.sessions.attachment(sessionId, messageId, index).then(image => {
    if (!image?.dataUrl) throw new Error('This image is no longer available.');
    const length = image.dataUrl.length;
    if (length <= MAX_DATA_LENGTH) {
      images.set(key, image);
      dataLength += length;
      while (images.size > MAX_IMAGES || dataLength > MAX_DATA_LENGTH) {
        const oldest = images.keys().next().value!;
        dataLength -= images.get(oldest)?.dataUrl?.length ?? 0;
        images.delete(oldest);
      }
    }
    return image;
  }).finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}
