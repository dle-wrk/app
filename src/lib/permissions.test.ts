import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({
  pool: { connect: async () => { throw new Error('the real pool must not be used in tests'); } },
  query: async () => { throw new Error('the real query must not be used in tests'); },
  queryOne: async () => null,
  exec: async () => {},
}));

import { currentUserCan, notAllowedMessage, roleCan, rolesWith } from './permissions';
import { requirePermission } from './authRoutes';

afterEach(() => localStorage.clear());

describe('roleCan', () => {
  it('lets admins, managers and engineers change inventory, and not viewers', () => {
    expect(['admin', 'manager', 'engineer', 'viewer'].map((r) => roleCan(r, 'inventory.update'))).toEqual([true, true, true, false]);
    expect(roleCan('Manager ', 'inventory.update')).toBe(true);
  });

  it('gives an unknown or missing role nothing, and an admin everything', () => {
    expect(roleCan('user', 'inventory.read')).toBe(false);
    expect(roleCan(null, 'inventory.read')).toBe(false);
    expect(roleCan('admin', 'users.delete')).toBe(true);
    expect(roleCan('engineer', 'users.read')).toBe(false);
  });

  it('says who may do something', () => {
    expect(rolesWith('inventory.update')).toBe('admins, managers and engineers');
    expect(rolesWith('users.delete')).toBe('admins');
    expect(notAllowedMessage('inventory.update')).toBe('Only admins, managers and engineers can change inventory, prices and part numbers.');
  });
});

describe('currentUserCan', () => {
  it("reads the signed-in user's role", () => {
    expect(currentUserCan('inventory.update')).toBe(false);
    localStorage.setItem('currentUser', JSON.stringify({ email: 'e@example.com', role: 'engineer' }));
    expect(currentUserCan('inventory.update')).toBe(true);
    localStorage.setItem('currentUser', JSON.stringify({ email: 'v@example.com', role: 'viewer' }));
    expect(currentUserCan('inventory.update')).toBe(false);
    localStorage.setItem('currentUser', '{not json');
    expect(currentUserCan('inventory.update')).toBe(false);
  });
});

describe('requirePermission', () => {
  const run = (user?: { role: string }) => {
    const res: any = { statusCode: 200, body: undefined, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
    const next = vi.fn();
    requirePermission('inventory.update')({ user }, res, next);
    return { allowed: next.mock.calls.length === 1, status: res.statusCode, body: res.body };
  };

  it('lets a permitted role through and refuses the rest, saying who may', () => {
    expect(run({ role: 'engineer' }).allowed).toBe(true);
    expect(run({ role: 'viewer' })).toEqual({ allowed: false, status: 403, body: { error: 'Only admins, managers and engineers can change inventory, prices and part numbers.' } });
    expect(run(undefined)).toEqual({ allowed: false, status: 401, body: { error: 'Sign in required' } });
  });
});
