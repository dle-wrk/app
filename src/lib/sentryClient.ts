// Sentry wiring for the React client. No-ops when the DSN isn't baked into
// the bundle at build time. Set VITE_SENTRY_DSN in Fly's secrets and rebuild
// to turn it on.
import * as Sentry from '@sentry/react';

const dsn = (import.meta as any).env?.VITE_SENTRY_DSN as string | undefined;

if (dsn) {
  Sentry.init({
    dsn,
    environment: (import.meta as any).env?.MODE || 'production',
    // We only care about errors on the client; tracing costs quota and mostly
    // adds noise for an internal ERP. Bump for perf investigations.
    tracesSampleRate: 0,
    // Redact obvious secrets in any breadcrumb URLs — Sentry captures fetch()
    // URLs by default, so a stray query-param token would otherwise leak.
    beforeBreadcrumb(breadcrumb) {
      if (breadcrumb.data?.url && typeof breadcrumb.data.url === 'string') {
        breadcrumb.data.url = breadcrumb.data.url.replace(/(reset|token)=[^&]+/gi, '$1=[redacted]');
      }
      return breadcrumb;
    },
    // Tag the current user (email + id) so a Sentry issue points at the person
    // who hit it. Called from App.tsx after login.
  });
  console.info('[sentry] client-side reporting enabled');
}

export const sentryEnabled = !!dsn;
export { Sentry };
