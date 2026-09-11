// User management surface extracted from server.ts. Owns: user CRUD (admin-only),
// per-user permissions read, role listing, and one-shot role-permission seeder.
//
// This module depends on requireAdmin/BCRYPT_ROUNDS from authRoutes rather than
// re-deriving them, so auth stays the single source of truth for the admin-gate
// contract and bcrypt cost.

import type { Express } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { query, queryOne } from './db';
import { CreateUserSchema, UpdateUserSchema, validateBody } from './serverUtils';
import { requireAdmin, BCRYPT_ROUNDS } from './authRoutes';

// Random human-typable temp password. Avoids ambiguous chars (0/O, 1/l/I)
// because these get read out over Slack / chat and dictated over the
// phone. 12 chars from a 54-char alphabet ≈ 69 bits of entropy — plenty
// for a single-use temp password that gets rotated on first login.
function generateTempPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

// Default role→permission grants used by the one-shot seeder. Kept alongside
// the seeder route rather than in a config file — this is boot-time data, not
// runtime config, and the values only change when we add a new capability.
const DEFAULT_ROLE_PERMISSIONS: Record<string, string[]> = {
  admin: [
    'users.create', 'users.read', 'users.update', 'users.delete',
    'inventory.create', 'inventory.read', 'inventory.update', 'inventory.delete',
    'suppliers.create', 'suppliers.read', 'suppliers.update', 'suppliers.delete',
    'orders.create', 'orders.read', 'orders.update', 'orders.delete',
    'reports.read', 'settings.update', 'automation.create', 'automation.delete',
  ],
  manager: [
    'users.read',
    'inventory.create', 'inventory.read', 'inventory.update',
    'suppliers.read', 'suppliers.update',
    'orders.create', 'orders.read', 'orders.update',
    'reports.read', 'automation.create',
  ],
  viewer: [
    'inventory.read', 'suppliers.read', 'orders.read', 'reports.read',
  ],
};

export function registerUsersRoutes(app: Express): void {
  // Seed role_permissions with our defaults. Idempotent via ON CONFLICT.
  // Not admin-gated: it's a boot bootstrap for the very first admin who needs
  // permissions to exist before they can be granted.
  app.post('/api/users/init-roles', async (_req, res) => {
    try {
      for (const [role, perms] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
        for (const permission of perms) {
          await query(
            `INSERT INTO role_permissions (role, permission) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [role, permission],
          );
        }
      }
      res.json({ ok: true, message: 'Roles and permissions initialized' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/users', requireAdmin, async (_req, res) => {
    try {
      const { rows } = await query(
        `SELECT id, email, first_name, last_name, role, status, created_at, last_login
         FROM users ORDER BY created_at DESC`,
      );
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/users', requireAdmin, validateBody(CreateUserSchema), async (req, res) => {
    try {
      const { email, password, firstName, lastName, role } = req.body as z.infer<typeof CreateUserSchema>;
      const hashedPassword = await bcrypt.hash(String(password), BCRYPT_ROUNDS);

      const { rows } = await query(
        `INSERT INTO users (email, password, first_name, last_name, role, status)
         VALUES ($1, $2, $3, $4, $5, 'ACTIVE')
         RETURNING id, email, first_name, last_name, role, status, created_at`,
        [String(email).toLowerCase().trim(), hashedPassword, firstName, lastName, role || 'viewer'],
      );

      console.log(`[POST /api/users] Created user: ${email}`);
      res.status(201).json(rows[0]);
    } catch (err: any) {
      if (err.message.includes('duplicate')) {
        res.status(409).json({ error: 'Email already exists' });
      } else {
        res.status(500).json({ error: err.message });
      }
    }
  });

  app.put('/api/users/:id', requireAdmin, validateBody(UpdateUserSchema), async (req, res) => {
    try {
      const { id } = req.params;
      const { firstName, lastName, role, status } = req.body as z.infer<typeof UpdateUserSchema>;

      const { rows } = await query(
        `UPDATE users SET first_name = $1, last_name = $2, role = $3, status = $4, updated_at = CURRENT_TIMESTAMP
         WHERE id = $5
         RETURNING id, email, first_name, last_name, role, status, updated_at`,
        [firstName, lastName, role, status, id],
      );

      if (rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      console.log(`[PUT /api/users] Updated user: ${id}`);
      res.json(rows[0]);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Admin-driven password reset. Generates a fresh random temp password,
  // stores its bcrypt hash, flips must_change_password=true, and drops
  // any live sessions for that user so a still-signed-in tab gets kicked
  // to login on its next verify. The plaintext temp password is only
  // ever surfaced ONCE — in the response body — so the admin can share
  // it out-of-band with the target user; it's never persisted anywhere
  // else and can't be recovered later. If the admin loses it, run this
  // endpoint again for a new one.
  app.post('/api/users/:id/reset-password', requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!id || Number.isNaN(id)) return res.status(400).json({ error: 'invalid user id' });

      const user = await queryOne<{ id: number; email: string; status: string }>(
        `SELECT id, email, status FROM users WHERE id = $1`,
        [id]
      );
      if (!user) return res.status(404).json({ error: 'User not found' });

      const tempPassword = generateTempPassword();
      const hashed = await bcrypt.hash(tempPassword, BCRYPT_ROUNDS);
      await query(
        `UPDATE users
            SET password = $1,
                must_change_password = TRUE,
                status = 'ACTIVE',
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $2`,
        [hashed, id]
      );
      // Kick any live sessions for this user so someone signed in on a
      // stale device gets bounced back to login on the next verify poll.
      await query(`DELETE FROM user_sessions WHERE user_id = $1`, [id]).catch(() => {});

      console.log(`[users] Admin ${(req as any).user?.email || 'unknown'} reset password for user ${id} (${user.email})`);
      res.json({ ok: true, email: user.email, tempPassword });
    } catch (err: any) {
      console.error('[users:reset-password] failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/users/:id', requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { rowCount } = await query('DELETE FROM users WHERE id = $1', [id]);

      if (rowCount === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      console.log(`[DELETE /api/users] Deleted user: ${id}`);
      res.json({ ok: true, message: 'User deleted' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/users/:id/permissions', async (req, res) => {
    try {
      const { id } = req.params;

      const userRes = await queryOne<{ role: string }>(
        'SELECT role FROM users WHERE id = $1',
        [id],
      );
      if (!userRes) {
        return res.status(404).json({ error: 'User not found' });
      }

      const { rows } = await query(
        'SELECT permission FROM role_permissions WHERE role = $1 ORDER BY permission',
        [userRes.role],
      );

      res.json({
        role: userRes.role,
        permissions: rows.map(r => r.permission),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/roles', async (_req, res) => {
    try {
      const { rows } = await query(
        `SELECT DISTINCT role FROM role_permissions ORDER BY role`,
      );
      res.json(rows.map(r => r.role));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
