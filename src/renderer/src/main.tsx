import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { createWebEmulator } from './bridge/webEmulator';

// In the Electron build the preload injects `window.emulator`. In the web build
// there is no preload, so install the WebSocket-backed bridge before the app
// mounts — the rest of the renderer is identical across both targets.
if (!window.emulator) {
  window.emulator = createWebEmulator();
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
