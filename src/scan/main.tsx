import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import { ScanApp } from './ScanApp';

// The phone scan page (tracklab-im.fly.dev/scan): its own small entry, so a
// phone doesn't download the whole web app to scan a reel.
createRoot(document.getElementById('root')!).render(<StrictMode><ScanApp /></StrictMode>);
