// @vitest-environment node
import type { Server } from 'node:http';
import express from 'express';
import bcrypt from 'bcryptjs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// The admin "break-glass" sign-in: it works only with the SEED_ADMIN_PASSWORD
// secret. There used to be a built-in fallback password, readable in this
// public repository, that opened the admin account on any server started
// without the secret.

const user = vi.hoisted(() => ({ hash: '' }));
vi.mock('./db', () => {
  const run = async (text: string) => {
    if (/FROM users WHERE email = \$1/.test(text)) {
      return { rows: [{ id: 1, email: 'dedw13@gmail.com', first_name: 'A', last_name: 'B', role: 'admin', status: 'ACTIVE', password: user.hash, must_change_password: false }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return { pool: { connect: async () => ({ query: run, release: () => {} }) }, query: run, queryOne: async (t: string) => (await run(t)).rows[0] ?? null, exec: async () => {} };
});

import { registerAuthRoutes } from './authRoutes';

let server: Server;
let base = '';
beforeAll(async () => {
  user.hash = await bcrypt.hash('the-real-password', 4);
  const app = express();
  app.use(express.json());
  registerAuthRoutes(app);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));
afterEach(() => { vi.unstubAllEnvs(); });

const signIn = async (password: string) => (await fetch(`${base}/api/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.0.0.${Math.floor(Math.random() * 250)}` },
  body: JSON.stringify({ email: 'dedw13@gmail.com', password }),
})).status;

describe('admin sign-in', () => {
  it('refuses the old built-in password when no secret is set', async () => {
    vi.stubEnv('SEED_ADMIN_PASSWORD', '');
    expect(await signIn('tracklabadm1n')).toBe(401);
    expect(await signIn('the-real-password')).toBe(200);
  });

  it('accepts the secret, when one is set', async () => {
    vi.stubEnv('SEED_ADMIN_PASSWORD', 'break-glass-secret');
    expect(await signIn('break-glass-secret')).toBe(200);
    expect(await signIn('tracklabadm1n')).toBe(401);
  });
});
