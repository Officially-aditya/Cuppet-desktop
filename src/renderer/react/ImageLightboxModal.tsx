import { useCallback, useEffect, useState } from 'react';

type ImageLightboxProps = {
  src: string;
  name?: string;
  onClose: () => void;
};

export function ImageLightboxModal({ src, name = 'Image Preview', onClose }: ImageLightboxProps) {
  const [zoom, setZoom] = useState(1);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose]);

  const handleZoomIn = () => setZoom((z) => Math.min(z + 0.25, 3));
  const handleZoomOut = () => setZoom((z) => Math.max(z - 0.25, 0.5));
  const handleResetZoom = () => setZoom(1);

  const handleCopy = useCallback(async () => {
    try {
      if (src.startsWith('data:image/')) {
        const res = await fetch(src);
        const blob = await res.blob();
        await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } else {
        await navigator.clipboard.writeText(src);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch {
      void navigator.clipboard.writeText(src);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [src]);

  return (
    <div className="modal-backdrop lightbox-backdrop" onClick={onClose}>
      <div className="image-lightbox-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="image-lightbox-header">
          <div className="image-lightbox-title" title={name}>
            <span className="image-lightbox-icon">🖼️</span>
            <span className="image-lightbox-filename">{name}</span>
          </div>
          <div className="image-lightbox-controls">
            <button type="button" className="lightbox-btn" onClick={handleZoomOut} title="Zoom out" disabled={zoom <= 0.5}>
              −
            </button>
            <button type="button" className="lightbox-btn lightbox-zoom-label" onClick={handleResetZoom} title="Reset zoom">
              {Math.round(zoom * 100)}%
            </button>
            <button type="button" className="lightbox-btn" onClick={handleZoomIn} title="Zoom in" disabled={zoom >= 3}>
              +
            </button>
            <button type="button" className={`lightbox-btn${copied ? ' copied' : ''}`} onClick={() => void handleCopy()} title="Copy image">
              {copied ? '✓ Copied' : 'Copy'}
            </button>
            <a href={src} download={name || 'image'} className="lightbox-btn lightbox-download-btn" title="Download image">
              Download
            </a>
            <button type="button" className="lightbox-btn lightbox-close-btn" onClick={onClose} aria-label="Close" title="Close (Esc)">
              ×
            </button>
          </div>
        </div>
        <div className="image-lightbox-body">
          <div className="image-lightbox-scroll-pane">
            <img
              src={src}
              alt={name}
              className="image-lightbox-img"
              style={{ transform: `scale(${zoom})`, transformOrigin: 'center center' }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
