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
        let pngBlob: Blob | null = null;
        if (src.startsWith('data:image/png;base64,')) {
          const res = await fetch(src);
          pngBlob = await res.blob();
        } else {
          // Chromium on Windows only accepts image/png on navigator.clipboard.write
          pngBlob = await new Promise<Blob | null>((resolve) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
              const canvas = document.createElement('canvas');
              canvas.width = img.naturalWidth;
              canvas.height = img.naturalHeight;
              const ctx = canvas.getContext('2d');
              if (!ctx) return resolve(null);
              ctx.drawImage(img, 0, 0);
              canvas.toBlob((blob) => resolve(blob), 'image/png');
            };
            img.onerror = () => resolve(null);
            img.src = src;
          });
        }
        if (pngBlob) {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
          return;
        }
      }
      await navigator.clipboard.writeText(src);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
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
