import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './commands.css';
import './navigation.css';
import './settings.css';
import './execution.css';
import './react.css';
import './usage.css';
import './composer-refinements.css';
import './message-controls.css';
import './sidebar-icons.css';
import './controls.css';
import './provider-model-settings.css';
import './general-settings.css';
import './permission-inline.css';
import './workspace-enhancements.css';
import { App } from './react/App';
import { WorkspaceEnhancements } from './react/WorkspaceEnhancements';
import { installSessionRetentionCleanup } from './react/session-retention';
import './types';

installSessionRetentionCleanup();

const root = document.getElementById('root');
if (!root) throw new Error('Renderer root is missing');

createRoot(root).render(
  <React.StrictMode>
    <App />
    <WorkspaceEnhancements />
  </React.StrictMode>,
);
