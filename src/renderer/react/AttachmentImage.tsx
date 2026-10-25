import { useEffect, useRef, useState } from 'react';
import type { Attachment } from '../types';
import { cachedAttachment, loadAttachment } from './attachment-cache';

type Props = {
  sessionId: string;
  messageId: string;
  index: number;
  attachment: Attachment;
  onOpenLightbox?: (image: { src: string; name?: string }) => void;
};

export function AttachmentImage({ sessionId, messageId, index, attachment, onOpenLightbox }: Props) {
  const button = useRef<HTMLButtonElement>(null);
  const [src, setSrc] = useState(() => attachment.dataUrl ?? cachedAttachment(sessionId, messageId, index)?.dataUrl ?? '');
  const [error, setError] = useState('');

  useEffect(() => {
    let disposed = false;
    const initial = attachment.dataUrl ?? cachedAttachment(sessionId, messageId, index)?.dataUrl ?? '';
    setSrc(initial);
    setError('');
    if (initial || !attachment.hasData) return;
    const load = () => {
      void loadAttachment(sessionId, messageId, index).then(image => {
        if (!disposed) setSrc(image.dataUrl!);
      }).catch(reason => { if (!disposed) setError(String(reason?.message ?? reason)); });
    };
    const node = button.current;
    const observer = typeof IntersectionObserver === 'undefined' || !node ? null : new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer?.disconnect(); load(); }
    }, { rootMargin: '200px' });
    if (observer && node) observer.observe(node);
    else load();
    return () => { disposed = true; observer?.disconnect(); };
  }, [sessionId, messageId, index, attachment.dataUrl, attachment.hasData]);

  const open = async () => {
    setError('');
    try {
      const image = src || (await loadAttachment(sessionId, messageId, index)).dataUrl!;
      setSrc(image);
      onOpenLightbox?.({ src: image, name: attachment.name });
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  return (
    <button ref={button} type="button" className="message-image-thumb-btn" title={error || `View ${attachment.name || 'image'}`}
      aria-label={`View ${attachment.name || 'image'}`} onClick={() => void open()}>
      {src ? <img src={src} alt={attachment.name || ''} loading="lazy" /> :
        <span className="message-image-placeholder" role={error ? 'alert' : 'status'}>{error ? 'Image unavailable · Click to retry' : 'Loading image…'}</span>}
    </button>
  );
}
