import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './commands.css';
import './navigation.css';
import './settings.css';
import './execution.css';
import './react.css';
import { App } from './react/App';
import './types';

const root = document.getElementById('root');
if (!root) throw new Error('Renderer root is missing');

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
