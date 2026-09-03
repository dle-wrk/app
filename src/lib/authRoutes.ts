// Auth surface extracted from server.ts. Owns: login, session verify/logout,
// forgot-password/reset flow, and the middlewares those consumers need.
//
// Two middlewares are *exported* rather than kept private because other
// still-un-extracted routers in server.ts need them:
//   - attachSessionUser is wired as global /api middleware in server.ts
//   - requireAdmin is used by /api/pricing/*, /api/users/*, /api/docs/*
// Once those domains get their own router files, the imports here stay valid.

import type { Express, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { randomBytes, createHmac } from 'node:crypto';
import { query, queryOne } from './db';
import {
  checkRateLimit as _checkRateLimit,
  clientIp,
  deriveCredKey,
  EmailSchema,
  LoginSchema,
  SessionIdSchema,
  validateBody,
} from './serverUtils';

// bcrypt cost 10 — ~50ms per hash on cheap hardware, fine for interactive login.
export const BCRYPT_ROUNDS = 10;
const LEGACY_HASH = (pw: string) => Buffer.from(pw).toString('base64');
const isBcryptHash = (v: string | null | undefined) => !!v && v.startsWith('$2');

// Same key-derivation as the pricing-cred store. Different HMAC context
// string keeps the two derived keys distinct even though they seed from the
// same env material.
const CRED_KEY_MATERIAL = process.env.PRICING_CRED_KEY
  || `fallback:${process.env.DATABASE_URL || 'dev'}`;
const CRED_KEY = deriveCredKey(CRED_KEY_MATERIAL);

// In-memory sliding-window buckets, keyed per (endpoint, ip[+identifier]).
// This module owns its own bucket map — separate from any other rate-limited
// domain — so a burst of login attempts doesn't share quota with, say, docs
// writes. Both maps live in the same process either way; this is only about
// keying discipline.
const rateBuckets = new Map<string, number[]>();
const checkRateLimit = (key: string, max: number, windowMs: number) =>
  _checkRateLimit(rateBuckets, key, max, windowMs);

// ---------------------------------------------------------------------------
// Password verification with silent upgrade of legacy formats.
// Accepts three storage formats we've had in the DB at various points:
//   - bcrypt ($2a/$2b/$2y prefix)          — current
//   - Buffer.from(pw).toString('base64')   — earlier attempt
//   - raw plaintext                        — original seeded demo row
// ---------------------------------------------------------------------------
export async function verifyAndUpgradePassword(
  userId: number, submitted: string, stored: string | null,
): Promise<boolean> {
  if (!stored) return false;
  if (isBcryptHash(stored)) return bcrypt.compare(submitted, stored);
  const isLegacyMatch = stored === LEGACY_HASH(submitted) || stored === submitted;
  if (!isLegacyMatch) return false;
  const upgraded = await bcrypt.hash(submitted, BCRYPT_ROUNDS);
  await query(`UPDATE users SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [upgraded, userId]);
  return true;
}

// ---------------------------------------------------------------------------
// Middlewares.
// ---------------------------------------------------------------------------

// Attach req.user if a valid session ID is presented via X-Session-Id header
// or body.sessionId. Silent no-op for anonymous requests.
export async function attachSessionUser(req: any, _res: Response, next: NextFunction): Promise<void> {
  try {
    const sessionId = String(req.headers?.['x-session-id'] ?? req.body?.sessionId ?? '');
    if (!sessionId) return next();
    const row = await queryOne<{ id: number; email: string; role: string; status: string }>(
      `SELECT u.id, u.email, u.role, u.status
         FROM user_sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.id = $1`,
      [sessionId]
    );
    if (row && row.status === 'ACTIVE') {
      req.user = { id: row.id, email: row.email, role: (row.role || '').toLowerCase() };
    }
  } catch (err: any) {
    console.warn('attachSessionUser failed:', err.message);
  }
  next();
}

// Require an active session tied to an admin role.
export function requireAdmin(req: any, res: Response, next: NextFunction): void {
  const user = req.user;
  if (!user) { res.status(401).json({ error: 'Sign in required' }); return; }
  if (user.role !== 'admin') { res.status(403).json({ error: 'Admin access required' }); return; }
  next();
}

// ---------------------------------------------------------------------------
// Session helpers.
// ---------------------------------------------------------------------------

// Mint a fresh session id and wipe any prior sessions for the same email.
// Older devices on that account will fail their next verify and get kicked.
async function mintSessionAndKickOthers(email: string, userId: number | null, req: Request): Promise<string> {
  const sessionId = randomBytes(24).toString('hex');
  const ua = String(req.headers?.['user-agent'] ?? '').slice(0, 500);
  const ip = String(
    req.headers?.['x-forwarded-for'] ?? req.headers?.['x-real-ip'] ?? req.socket?.remoteAddress ?? ''
  ).split(',')[0].trim().slice(0, 100);
  await query(`DELETE FROM user_sessions WHERE user_email = $1`, [email]);
  await query(
    `INSERT INTO user_sessions (id, user_email, user_id, user_agent, ip_address) VALUES ($1, $2, $3, $4, $5)`,
    [sessionId, email, userId, ua, ip]
  );
  return sessionId;
}

// ---------------------------------------------------------------------------
// Password reset.
// ---------------------------------------------------------------------------

const RESET_TOKEN_TTL_MIN = 30;
const RESET_TOKEN_BYTES = 24; // 32-char base64url — plenty for a URL fragment

const ForgotPasswordSchema = z.object({ email: EmailSchema });
const ResetPasswordSchema = z.object({
  token: z.string().min(16).max(200),
  password: z.string().min(8).max(200),
});

function hashResetToken(token: string): string {
  return createHmac('sha256', CRED_KEY).update(token).digest('hex');
}

async function sendPasswordResetEmail(toEmail: string, resetUrl: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM || 'Tracklab IM <noreply@tracklab.local>';
  if (!apiKey) {
    console.log(`[password-reset] No RESEND_API_KEY configured. Reset link for ${toEmail}:`);
    console.log(`[password-reset]   ${resetUrl}`);
    return;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [toEmail],
        subject: 'Reset your Tracklab IM password',
        html: `<p>Someone (hopefully you) asked to reset the password for this account.</p>
               <p><a href="${resetUrl}">Click here to choose a new one</a>. The link expires in ${RESET_TOKEN_TTL_MIN} minutes.</p>
               <p>If it wasn't you, ignore this email — nothing has changed.</p>`,
        text: `Reset your Tracklab IM password: ${resetUrl}\n\nExpires in ${RESET_TOKEN_TTL_MIN} minutes. If it wasn't you, ignore this email.`,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn(`[password-reset] Resend rejected (${res.status}): ${body.slice(0, 200)}`);
    }
  } catch (err: any) {
    console.warn('[password-reset] Resend call failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Route registration.
// ---------------------------------------------------------------------------
export function registerAuthRoutes(app: Express): void {
  // -------------------- POST /api/login --------------------
  app.post('/api/login', validateBody(LoginSchema), async (req, res) => {
    try {
      const { email, password } = req.body as z.infer<typeof LoginSchema>;
      const ip = clientIp(req);
      const normalizedEmail = String(email).toLowerCase().trim();

      // Two-key limiter: IP alone catches distributed guesses against one
      // account, IP+email catches a slow-and-low burn per user. 10/5min is
      // roomy enough that a real user typing wrong twice doesn't get blocked.
      for (const [key, max] of [
        [`login:ip:${ip}`, 20],
        [`login:pair:${ip}:${normalizedEmail}`, 10],
      ] as const) {
        const check = checkRateLimit(key, max, 5 * 60_000);
        if (!check.allowed) {
          res.setHeader('Retry-After', String(check.retryAfter));
          return res.status(429).json({ error: `Too many login attempts. Try again in ${check.retryAfter}s.` });
        }
      }

      try {
        const { rows } = await query(
          `SELECT id, email, first_name, last_name, role, status, password FROM users WHERE email = $1`,
          [normalizedEmail]
        );
        if (rows.length === 0) {
          return res.status(401).json({ error: 'Invalid email or password' });
        }

        const user = rows[0];

        // Seed admin recovery: whoever holds the SEED_ADMIN_PASSWORD Fly secret
        // can always log in as the seed admin — this is the master recovery
        // path. On use we reactivate the row if it's been deactivated. We do
        // NOT overwrite the stored bcrypt hash: the seed password is the
        // *break-glass* key, not the daily one; the user's real password keeps
        // working after they log in with the seed password and fix things up.
        const seedPw = process.env.SEED_ADMIN_PASSWORD || 'tracklabadm1n';
        const seedEmail = (process.env.SEED_ADMIN_EMAIL || 'dedw13@gmail.com').toLowerCase().trim();
        const isSeedRecovery = normalizedEmail === seedEmail && String(password) === seedPw;

        if (isSeedRecovery && user.status !== 'ACTIVE') {
          await query(`UPDATE users SET status = 'ACTIVE', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [user.id]);
          user.status = 'ACTIVE';
          console.log(`[login] Reactivated seed admin ${seedEmail}`);
        }

        if (user.status !== 'ACTIVE') {
          return res.status(401).json({ error: 'User account is not active' });
        }

        let passwordMatch = await verifyAndUpgradePassword(user.id, String(password), user.password);

        // Seed recovery bypasses the bcrypt check.
        if (!passwordMatch && isSeedRecovery) {
          console.log(`[login] Seed admin ${seedEmail} authenticated via SEED_ADMIN_PASSWORD (recovery)`);
          passwordMatch = true;
        }

        if (!passwordMatch) {
          return res.status(401).json({ error: 'Invalid email or password' });
        }

        const sessionId = await mintSessionAndKickOthers(user.email, user.id, req).catch(() => null);

        res.json({
          id: user.id,
          email: user.email,
          firstName: user.first_name,
          lastName: user.last_name,
          role: user.role,
          status: user.status,
          sessionId,
        });
      } catch (dbErr: any) {
        // DB unreachable / rejecting queries. Previously this was 401 which
        // masked "wrong DB role" as "wrong password" (see the neondb_owner
        // vs authenticator debug chase). 503 lets client + operators tell them
        // apart at a glance.
        console.error('Database login error:', dbErr.message, dbErr.code || '');
        return res.status(503).json({
          error: 'Database unavailable — please try again shortly',
          code: dbErr.code,
        });
      }
    } catch (err: any) {
      console.error('Login error:', err.message);
      res.status(500).json({ error: 'Authentication failed' });
    }
  });

  // -------------------- POST /api/session/verify --------------------
  // Client polls this every ~30s. Returns active:false when the sessionId is
  // missing from user_sessions — either the user logged in from another device
  // (which deleted the row) or explicitly signed out here.
  app.post('/api/session/verify', validateBody(SessionIdSchema), async (req, res) => {
    try {
      const sessionId = String(req.body?.sessionId ?? req.headers?.['x-session-id'] ?? '');
      if (!sessionId) return res.json({ active: false, reason: 'missing_session_id' });
      // 200/min per IP is far above the client's 2/min polling cadence but keeps
      // a runaway loop from turning into a DB stampede.
      const check = checkRateLimit(`verify:ip:${clientIp(req)}`, 200, 60_000);
      if (!check.allowed) {
        res.setHeader('Retry-After', String(check.retryAfter));
        return res.status(429).json({ error: 'Too many verify calls' });
      }
      const row = await queryOne<{ user_email: string }>(
        `SELECT user_email FROM user_sessions WHERE id = $1`,
        [sessionId]
      );
      if (!row) return res.json({ active: false, reason: 'signed_in_elsewhere' });
      // Cheap heartbeat so we could add an idle-timeout later without another table.
      await query(`UPDATE user_sessions SET last_seen = CURRENT_TIMESTAMP WHERE id = $1`, [sessionId]).catch(() => {});
      res.json({ active: true, email: row.user_email });
    } catch (err: any) {
      // Fail open on transient DB errors — don't spuriously kick a logged-in user
      // just because Neon hiccupped. A real "kicked" signal must come from the DB.
      console.error('Session verify error:', err.message);
      res.json({ active: true, degraded: true });
    }
  });

  // -------------------- POST /api/session/logout --------------------
  app.post('/api/session/logout', validateBody(SessionIdSchema), async (req: any, res) => {
    try {
      const sessionId = String(req.body?.sessionId ?? req.headers?.['x-session-id'] ?? '');
      if (!sessionId) return res.json({ ok: true });

      // Only allow logout if the caller owns that session, or is an admin.
      // Without this any 48-char hex leak could force other users out.
      const row = await queryOne<{ user_id: number }>(
        `SELECT user_id FROM user_sessions WHERE id = $1`,
        [sessionId]
      );
      if (!row) return res.json({ ok: true }); // already gone

      const caller = req.user;
      const isOwner = caller && caller.id === row.user_id;
      const isAdmin = caller && caller.role === 'admin';
      if (!isOwner && !isAdmin) {
        return res.status(403).json({ error: 'Not allowed to end this session' });
      }

      await query(`DELETE FROM user_sessions WHERE id = $1`, [sessionId]);
      res.json({ ok: true });
    } catch (err: any) {
      console.error('Session logout error:', err.message);
      // Fail-open: pretend it worked so a jittery DB doesn't leave a UI stuck
      // with a spinner. The next verify will still reflect reality.
      res.json({ ok: true });
    }
  });

  // -------------------- POST /api/auth/forgot-password --------------------
  app.post('/api/auth/forgot-password', validateBody(ForgotPasswordSchema), async (req, res) => {
    const { email } = req.body as z.infer<typeof ForgotPasswordSchema>;
    const ip = clientIp(req);
    // Rate-limit by IP AND by target address so a bulk-enumeration attack
    // can't fish for real users OR hammer real inboxes with reset spam.
    for (const [key, max] of [
      [`forgot:ip:${ip}`, 20],
      [`forgot:email:${email}`, 5],
    ] as const) {
      const check = checkRateLimit(key, max, 30 * 60_000);
      if (!check.allowed) {
        res.setHeader('Retry-After', String(check.retryAfter));
        return res.status(429).json({ error: `Too many reset attempts. Try again in ${check.retryAfter}s.` });
      }
    }

    // Fire-and-forget the token issue so timing doesn't leak whether the
    // email is registered.
    (async () => {
      try {
        const user = await queryOne<{ id: number; email: string; status: string }>(
          `SELECT id, email, status FROM users WHERE email = $1`,
          [email]
        );
        if (!user || user.status !== 'ACTIVE') return;

        const token = randomBytes(RESET_TOKEN_BYTES).toString('base64')
          .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MIN * 60_000);
        await query(
          `INSERT INTO password_reset_tokens (token_hash, user_email, expires_at, ip_address) VALUES ($1, $2, $3, $4)`,
          [hashResetToken(token), user.email, expiresAt.toISOString(), ip]
        );

        const origin = process.env.APP_ORIGIN || `${req.protocol}://${req.get('host')}`;
        const resetUrl = `${origin}/?reset=${encodeURIComponent(token)}`;
        await sendPasswordResetEmail(user.email, resetUrl);
      } catch (err: any) {
        console.warn('[password-reset] issue failed:', err.message);
      }
    })();

    // Constant response regardless of whether the email exists.
    res.json({ ok: true, message: 'If that email is registered, a reset link has been sent.' });
  });

  // -------------------- POST /api/auth/reset-password --------------------
  app.post('/api/auth/reset-password', validateBody(ResetPasswordSchema), async (req, res) => {
    const { token, password } = req.body as z.infer<typeof ResetPasswordSchema>;
    const ip = clientIp(req);
    const check = checkRateLimit(`reset:ip:${ip}`, 20, 30 * 60_000);
    if (!check.allowed) {
      res.setHeader('Retry-After', String(check.retryAfter));
      return res.status(429).json({ error: 'Too many attempts. Try again shortly.' });
    }
    try {
      const row = await queryOne<{ id: number; user_email: string; used_at: string | null; expires_at: string }>(
        `SELECT id, user_email, used_at, expires_at FROM password_reset_tokens WHERE token_hash = $1`,
        [hashResetToken(token)]
      );
      if (!row) return res.status(400).json({ error: 'Invalid or expired link' });
      if (row.used_at) return res.status(400).json({ error: 'This link has already been used' });
      if (new Date(row.expires_at).getTime() < Date.now()) {
        return res.status(400).json({ error: 'This link has expired — request a new one' });
      }

      const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);
      // Mark token used first so a race can't redeem the same token twice.
      const { rowCount: markedUsed } = await query(
        `UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = $1 AND used_at IS NULL`,
        [row.id]
      );
      if (markedUsed !== 1) return res.status(400).json({ error: 'This link has already been used' });

      await query(
        `UPDATE users SET password = $1, status = 'ACTIVE', updated_at = CURRENT_TIMESTAMP WHERE email = $2`,
        [hashed, row.user_email]
      );
      // Log the user out of every existing device — a password change should
      // invalidate whoever the attacker (or the user themself before) was.
      await query(`DELETE FROM user_sessions WHERE user_email = $1`, [row.user_email]);

      res.json({ ok: true, message: 'Password updated. Please sign in.' });
    } catch (err: any) {
      console.error('[reset-password] failed:', err.message);
      res.status(503).json({ error: 'Service unavailable — please try again shortly' });
    }
  });
}
