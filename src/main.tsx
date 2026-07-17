import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

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
