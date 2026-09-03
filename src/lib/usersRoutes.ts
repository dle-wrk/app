// User management surface extracted from server.ts. Owns: user CRUD (admin-only),
// per-user permissions read, role listing, and one-shot role-permission seeder.
//
// This module depends on requireAdmin/BCRYPT_ROUNDS from authRoutes rather than
// re-deriving them, so auth stays the single source of truth for the admin-gate
// contract and bcrypt cost.

import type { Express } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { query, queryOne } from './db';
import { CreateUserSchema, UpdateUserSchema, validateBody } from './serverUtils';
import { requireAdmin, BCRYPT_ROUNDS } from './authRoutes';

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
