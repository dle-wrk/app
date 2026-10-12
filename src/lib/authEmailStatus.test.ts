import { afterEach, describe, expect, it, vi } from 'vitest';

// "Forgot password?" without an email service, and the admin's email status.
vi.mock('./db', () => ({
  pool: { connect: async () => { throw new Error('the real pool must not be used in tests'); } },
  query: async () => ({ rows: [] }),
  queryOne: async () => null, // no such user
  exec: async () => {},
}));

import { registerAuthRoutes } from './authRoutes';

// A stand-in Express app that keeps the handlers, run in order like Express.
const routes = new Map<string, Function[]>();
const app: any = new Proxy({}, {
  get: (_t, method: string) => (path: string, ...handlers: Function[]) => { routes.set(`${method.toUpperCase()} ${path}`, handlers); },
});
registerAuthRoutes(app);

async function call(key: string, { body = {}, user }: { body?: any; user?: any } = {}) {
  const handlers = routes.get(key)!;
  const req: any = { body, user, headers: {}, ip: `10.0.0.${Math.floor(Math.random() * 250)}`, socket: {}, protocol: 'https', get: () => 'x' };
  const res: any = { statusCode: 200, body: undefined, headers: {}, status(c: number) { this.statusCode = c; return this; }, json(b: any) { this.body = b; return this; }, setHeader() {} };
  for (const h of handlers) {
    let advanced = false;
    await h(req, res, () => { advanced = true; });
    if (!advanced) break;
  }
  return res;
}

afterEach(() => { vi.unstubAllEnvs(); });

describe('forgot password without an email service', () => {
  it('says no email was sent, the same for any address', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    const a = await call('POST /api/auth/forgot-password', { body: { email: 'someone@example.com' } });
    const b = await call('POST /api/auth/forgot-password', { body: { email: 'nobody@example.com' } });
    expect(a.body.emailConfigured).toBe(false);
    expect(a.body.message).toMatch(/Ask an admin/);
    expect(b.body).toEqual(a.body);
  });

  it('keeps the usual reply when email is set up', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test');
    const r = await call('POST /api/auth/forgot-password', { body: { email: 'someone@example.com' } });
    expect(r.body).toEqual({ ok: true, emailConfigured: true, message: 'If that email is registered, a reset link has been sent.' });
  });
});

describe('GET /api/auth/email-status', () => {
  it('is for admins only, and says whether email is set up', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    expect((await call('GET /api/auth/email-status', { user: { id: 2, email: 'v@x.com', role: 'viewer' } })).statusCode).toBe(403);
    const r = await call('GET /api/auth/email-status', { user: { id: 1, email: 'a@x.com', role: 'admin' } });
    expect(r.body).toMatchObject({ configured: false, lastError: null });
    expect(JSON.stringify(r.body)).not.toContain('re_'); // never the key itself
  });
});
