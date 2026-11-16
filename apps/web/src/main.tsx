import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './design/tokens.css';
import './design/components.css';
import './design/icons.js';
import './design/motion.js';
import './app.css';
import { App } from './App';

document.documentElement.classList.add('js');
document.body.classList.add('has-wallpaper');
// The service worker is the phone's share target only (public/sw.js).
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => undefined);
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
