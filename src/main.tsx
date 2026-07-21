import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Suppress browser extension async message channel errors (Chrome extensions, DevTools, etc.)
const originalError = console.error;
console.error = function (...args: any[]) {
  const errorMsg = args[0]?.toString?.() || '';
  // Suppress known async message channel errors from browser extensions
  if (errorMsg.includes('message channel closed') || errorMsg.includes('asynchronous response')) {
    return;
  }
  return originalError.apply(console, args);
};

if (window.location.port === '3000') {
  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    if (typeof input === 'string' && input.startsWith('/api')) {
      input = 'http://127.0.0.1:3001' + input;
    } else if (input instanceof URL && input.pathname.startsWith('/api')) {
      input = new URL(input.pathname, 'http://127.0.0.1:3001');
    }
    return originalFetch(input, init);
  };
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
