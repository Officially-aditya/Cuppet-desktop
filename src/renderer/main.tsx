import React from 'react';
import './index.css';
import { createRoot } from 'react-dom/client';
import { installAppearance } from './react/appearance';
import { App } from './react/App';
import { DialogHost } from './react/DialogHost';
import { installSessionRetentionCleanup } from './react/session-retention';
import './types';

installAppearance();
installSessionRetentionCleanup();

const scrollbarIdleTimers = new WeakMap<Element, number>();
document.addEventListener('scroll', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  target.classList.add('scrollbar-active');
  window.clearTimeout(scrollbarIdleTimers.get(target));
  scrollbarIdleTimers.set(target, window.setTimeout(() => {
    target.classList.remove('scrollbar-active');
    scrollbarIdleTimers.delete(target);
  }, 1000));
}, { capture: true, passive: true });

const root = document.getElementById('root');
if (!root) throw new Error('Renderer root is missing');

createRoot(root).render(
  <React.StrictMode>
    <App />
    <DialogHost />
  </React.StrictMode>,
);
