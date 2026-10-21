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

const root = document.getElementById('root');
if (!root) throw new Error('Renderer root is missing');

createRoot(root).render(
  <React.StrictMode>
    <App />
    <DialogHost />
  </React.StrictMode>,
);
