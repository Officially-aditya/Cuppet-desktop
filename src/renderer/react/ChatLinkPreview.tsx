import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { openChatLink } from './project-links';

type SocialPreview = { url: string; hostname: string; title: string; description: string; siteName: string; image: string | null; icon: string | null };
type Hover = { target: HTMLElement; value: string; kind: 'web' | 'file'; social?: SocialPreview; file?: { path: string; name: string; icon: string | null }; loading?: boolean };

export function ChatLinkPreview({ projectId }: { projectId: string | null }) {
  const [hover, setHover] = useState<Hover | null>(null);
  const active = useRef<HTMLElement | null>(null);
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let timer: number | undefined;
    let closeTimer: number | undefined;
    setHover(null);
    const clearClose = () => window.clearTimeout(closeTimer);
    const close = () => {
      window.clearTimeout(timer); clearClose(); active.current = null; setHover(null);
    };
    const enter = (event: Event) => {
      const element = event.target instanceof Element ? event.target : null;
      if (element?.closest('[data-cuppet-link-preview]')) { clearClose(); return; }
      const target = element?.closest<HTMLElement>('[data-cuppet-project-file], [data-cuppet-external]');
      if (!target?.closest('.markdown-rendered')) return;
      clearClose();
      if (active.current === target) return;
      close();
      const file = target.getAttribute('data-cuppet-project-file');
      const value = file || target.getAttribute('href') || '';
      if (!file && !/^https?:\/\//i.test(value)) return;
      if (!file) { try { new URL(value); } catch { return; } }
      active.current = target;
      const kind = file ? 'file' : 'web';
      timer = window.setTimeout(() => {
        if (active.current !== target || !target.isConnected) return;
        const next: Hover = { target, value, kind, loading: kind === 'web' };
        setHover(next);
        if (kind === 'file') {
          if (!projectId || !window.cuppet.native.projectFileEditor) return;
          const path = value.replace(/:(?:\d+)(?::\d+)?(?:-\d+(?::\d+)?)?$/, '');
          void window.cuppet.native.projectFileEditor(projectId, path).then(info => {
            if (active.current === target && target.isConnected) setHover({ ...next, file: { ...info, path: info.path + value.slice(path.length) } });
          }).catch(() => undefined);
        } else {
          const hostname = new URL(value).hostname;
          const fallback: SocialPreview = { url: value, hostname, title: target.textContent || hostname, description: '', siteName: hostname, image: null, icon: null };
          void (window.cuppet.native.linkPreview?.(value) || Promise.resolve(fallback)).catch(() => fallback).then(social => {
            if (active.current === target && target.isConnected) setHover({ ...next, social, loading: false });
          });
        }
      }, kind === 'file' ? 2000 : 500);
    };
    const leave = (event: MouseEvent | FocusEvent) => {
      const next = event.relatedTarget instanceof Node ? event.relatedTarget : null;
      if (next && (active.current?.contains(next) || card.current?.contains(next))) return;
      window.clearTimeout(timer); clearClose();
      closeTimer = window.setTimeout(close, 150);
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    const scroll = (event: Event) => { if (!(event.target instanceof Node && card.current?.contains(event.target))) close(); };
    const observer = new MutationObserver(() => { if (active.current && !active.current.isConnected) close(); });
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('mouseover', enter);
    document.addEventListener('mouseout', leave);
    document.addEventListener('focusin', enter);
    document.addEventListener('focusout', leave);
    document.addEventListener('keydown', key);
    document.addEventListener('click', close);
    window.addEventListener('blur', close);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', close);
    return () => {
      window.clearTimeout(timer); clearClose(); active.current = null; observer.disconnect();
      document.removeEventListener('mouseover', enter);
      document.removeEventListener('mouseout', leave);
      document.removeEventListener('focusin', enter);
      document.removeEventListener('focusout', leave);
      document.removeEventListener('keydown', key);
      document.removeEventListener('click', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', close);
    };
  }, [projectId]);

  useLayoutEffect(() => {
    if (!hover || !card.current) return;
    const target = hover.target.getBoundingClientRect();
    const bounds = card.current.getBoundingClientRect();
    card.current.style.left = `${Math.max(12, Math.min(target.left, window.innerWidth - bounds.width - 12))}px`;
    const below = target.bottom + 8;
    card.current.style.top = `${Math.max(12, Math.min(below + bounds.height <= window.innerHeight - 12 ? below : target.top - bounds.height - 8, window.innerHeight - bounds.height - 12))}px`;
  }, [hover]);

  if (!hover) return null;
  return createPortal(
    <div ref={card} data-cuppet-link-preview className={`chat-link-preview ${hover.kind}`} role="tooltip">
      {hover.kind === 'file' ? <button type="button" className="chat-file-preview" data-cuppet-project-file={hover.value} onClick={(event) => { openChatLink(projectId, event.currentTarget); }}>
        <span className="chat-file-preview-path">{hover.file?.path || hover.value}</span>
        <span className="chat-link-preview-site">
          {hover.file?.icon && <img src={hover.file.icon} alt="" />}
          {hover.file?.name ? `Open in ${hover.file.name}` : 'Open in default app'}
        </span>
      </button> : <a className="chat-social-preview" href={hover.value} data-cuppet-external="true" target="_blank" rel="noreferrer noopener" onClick={(event) => { if (openChatLink(projectId, event.currentTarget)) event.preventDefault(); }}>
        {hover.social?.image && <img className="chat-link-preview-image" src={hover.social.image} alt="" />}
        <div className="chat-link-preview-content">
          <span className="chat-link-preview-site">
            {hover.social?.icon && <img src={hover.social.icon} alt="" />}
            {hover.social?.siteName || new URL(hover.value).hostname}
          </span>
          <strong>{hover.social?.title || hover.target.textContent || hover.value}</strong>
          {hover.social?.description && <p>{hover.social.description}</p>}
          <span className="chat-link-preview-url">{hover.loading ? 'Loading preview…' : hover.social?.hostname || new URL(hover.value).hostname}</span>
        </div>
      </a>}
    </div>,
    document.body,
  );
}
