import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
// Sentry side-effect import — must load before we mount <App/> so any error
// during render is captured. No-ops when VITE_SENTRY_DSN isn't set.
import { Sentry, sentryEnabled } from './lib/sentryClient';

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

// Route dev-server /api requests to the backend and, everywhere, attach the
// current session id so admin-gated endpoints know who's calling. Doing this
// once at the app boundary means every fetch — including third-party libs —
// picks up auth automatically.
const originalFetch = window.fetch;
window.fetch = function (input, init) {
  const isDevProxy = window.location.port === '3000';
  if (isDevProxy) {
    if (typeof input === 'string' && input.startsWith('/api')) {
      input = 'http://127.0.0.1:3001' + input;
    } else if (input instanceof URL && input.pathname.startsWith('/api')) {
      input = new URL(input.pathname, 'http://127.0.0.1:3001');
    }
  }
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  const isApiCall = /(^|\/\/[^/]+)?\/api\b/.test(url) || (isDevProxy && url.includes('127.0.0.1:3001'));
  if (isApiCall) {
    const sessionId = localStorage.getItem('sessionId');
    if (sessionId) {
      const headers = new Headers(init?.headers || {});
      if (!headers.has('X-Session-Id')) headers.set('X-Session-Id', sessionId);
      init = { ...init, headers };
    }
  }
  return originalFetch(input, init);
};

// Wrap App in Sentry.ErrorBoundary when enabled so uncaught React errors
// go to Sentry with component-stack + user context. The fallback UI is a
// deliberately dumb card — a real user seeing this should refresh and try
// again; anything smarter risks obscuring the underlying error.
const RootTree = sentryEnabled ? (
  <Sentry.ErrorBoundary
    fallback={({ error, resetError }) => (
      <div style={{ padding: 24, fontFamily: 'system-ui', color: '#fff', background: '#1a1d2b', minHeight: '100vh' }}>
        <h1 style={{ fontSize: 20, marginBottom: 8 }}>Something broke.</h1>
        <p style={{ opacity: 0.7, fontSize: 14 }}>The error has been reported. Try refreshing.</p>
        <pre style={{ fontSize: 11, opacity: 0.5, marginTop: 16, whiteSpace: 'pre-wrap' }}>{String((error as any)?.message || error)}</pre>
        <button onClick={resetError} style={{ marginTop: 16, padding: '8px 16px', background: '#f7912b', color: '#000', border: 0, borderRadius: 6, cursor: 'pointer' }}>Try again</button>
      </div>
    )}
  >
    <App />
  </Sentry.ErrorBoundary>
) : (
  <App />
);

createRoot(document.getElementById('root')!).render(
  <StrictMode>{RootTree}</StrictMode>,
);
