// Sentry wiring for the Express server. Silently no-ops when SENTRY_DSN
// isn't set, so nothing changes in dev / self-hosted setups without it.
import * as Sentry from '@sentry/node';

let initialized = false;

export function initSentry(): boolean {
  if (initialized) return true;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return false;

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || (process.env.FLY_APP_NAME ? 'production' : 'development'),
    release: process.env.SENTRY_RELEASE || undefined,
    // Server-side sampling stays low — we care about errors, not performance
    // profiles, and traces cost quota. Bump if you need transaction data.
    tracesSampleRate: 0.05,
    // We already redact secrets in logs and in URLs — but keep the safety net
    // that strips known-sensitive param names before shipping to Sentry.
    beforeSend(event) {
      if (event.request?.headers) {
        const h: any = event.request.headers;
        for (const k of Object.keys(h)) {
          if (/^(cookie|authorization|x-session-id)$/i.test(k)) h[k] = '[redacted]';
        }
      }
      return event;
    },
  });
  initialized = true;
  console.log('[sentry] server-side reporting enabled');
  return true;
}

/** Small middleware that tags every request with a request id so log lines
 *  match Sentry events. Add before the routes so downstream handlers can
 *  read req.id for their own logging. */
export function requestIdMiddleware() {
  return (req: any, _res: any, next: any) => {
    // Prefer a Fly-injected id if present (they set fly-request-id), else
    // roll one so every request gets one regardless of origin.
    const id = req.headers['fly-request-id'] || req.headers['x-request-id'] ||
      Math.random().toString(36).slice(2, 12);
    req.id = id;
    Sentry.getCurrentScope().setTag('request_id', id);
    next();
  };
}

/** Call last, after all routes are registered. Catches any thrown error in a
 *  handler and forwards it to Sentry with request context. */
export function attachErrorHandler(app: any): void {
  if (!initialized) return;
  Sentry.setupExpressErrorHandler(app);
}
