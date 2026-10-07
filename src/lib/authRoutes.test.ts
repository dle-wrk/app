import { describe, it, expect, vi } from 'vitest';

// The middleware under test never touches the database, but authRoutes
// imports ./db, which refuses to load without DATABASE_URL (CI has none).
vi.mock('./db', () => ({
  pool: { connect: async () => { throw new Error('the real pool must not be used in tests'); } },
  query: async () => { throw new Error('the real query must not be used in tests'); },
  queryOne: async () => null,
  exec: async () => {},
}));

import { requireSession } from './authRoutes';

// Mirrors how Express presents a request to middleware mounted at '/api':
// baseUrl is the mount point and path is what follows it.
function call(method: string, fullPath: string, user?: { id: number; email: string; role: string }) {
  const req: any = { method, baseUrl: '/api', path: fullPath.replace(/^\/api/, '') || '/', user };
  const res: any = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  const next = vi.fn();
  requireSession(req, res, next);
  return { allowed: next.mock.calls.length === 1, status: res.statusCode, body: res.body };
}

const staff = { id: 7, email: 'staff@example.com', role: 'user' };

describe('requireSession', () => {
  it('rejects anonymous calls to ordinary endpoints', () => {
    for (const [method, path] of [
      ['GET', '/api/items'],
      ['GET', '/api/bootstrap'],
      ['POST', '/api/invoices'],
      ['DELETE', '/api/items/ANT-001'],
      ['POST', '/api/activity-log'],
      ['GET', '/api/raw-table/users'],
      ['GET', '/api/does-not-exist'],
    ] as const) {
      const r = call(method, path);
      expect(r.allowed, `${method} ${path}`).toBe(false);
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ error: 'Sign in required' });
    }
  });

  it('lets a signed-in user through', () => {
    expect(call('GET', '/api/items', staff).allowed).toBe(true);
    expect(call('POST', '/api/invoices', staff).allowed).toBe(true);
  });

  it('keeps the sign-in and recovery calls open', () => {
    for (const [method, path] of [
      ['POST', '/api/login'],
      ['POST', '/api/session/verify'],
      ['POST', '/api/session/logout'],
      ['POST', '/api/auth/forgot-password'],
      ['POST', '/api/auth/reset-password'],
      ['GET', '/api/pricing/oauth/callback'],
      ['POST', '/api/pricing/lcsc/import'],
    ] as const) {
      expect(call(method, path).allowed, `${method} ${path}`).toBe(true);
    }
  });

  it('matches on method as well as path', () => {
    expect(call('GET', '/api/login').allowed).toBe(false);
    expect(call('POST', '/api/pricing/oauth/callback').allowed).toBe(false);
    // change-password is NOT public: it needs the session of the user changing it.
    expect(call('POST', '/api/auth/change-password').allowed).toBe(false);
  });

  it('ignores a trailing slash', () => {
    expect(call('POST', '/api/login/').allowed).toBe(true);
    expect(call('GET', '/api/items/').allowed).toBe(false);
  });
});
