// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AREAS, permissionForWrite, requireWriteAccess } from './writeAccess';
import { roleCan } from './permissions';

const ROLES = ['admin', 'manager', 'engineer', 'viewer'] as const;

/** Which roles may make a write (true/false per admin, manager, engineer, viewer). */
function who(method: string, p: string): boolean[] {
  return ROLES.map((role) => {
    const res: any = { statusCode: 200, status(c: number) { this.statusCode = c; return this; }, json() { return this; } };
    const next = vi.fn();
    requireWriteAccess({ method, baseUrl: '/api', path: p.replace(/^\/api/, ''), user: { id: 1, email: `${role}@x`, role } }, res, next);
    return next.mock.calls.length === 1;
  });
}

describe('every write route has an area', () => {
  it('is listed in AREAS, so nobody gets a default by accident', () => {
    const dir = path.resolve(__dirname);
    const files = [path.resolve(dir, '../../server.ts'), ...fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => path.join(dir, f))];
    const missing = new Set<string>();
    let routes = 0;
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/\.(post|put|patch|delete)\(\s*['`](\/api\/[^'`]+)/g)) {
        routes += 1;
        if (permissionForWrite(m[1], m[2]) === 'not-viewer') missing.add(`${m[1].toUpperCase()} ${m[2]} (${path.basename(file)})`);
      }
    }
    expect(routes).toBeGreaterThan(150);
    expect([...missing]).toEqual([]);
  });

  it('only names permissions that exist', () => {
    for (const rule of Object.values(AREAS)) {
      if (rule === 'open') continue;
      expect(roleCan('admin', rule.change)).toBe(true);
      expect(roleCan('admin', rule.remove)).toBe(true);
    }
  });
});

describe('who may change what', () => {
  it.each([
    // [method, path, admin, manager, engineer, viewer]
    ['POST', '/api/items', true, true, true, false],
    ['PATCH', '/api/items/CAP-009', true, true, true, false],
    ['DELETE', '/api/items/CAP-009', true, true, false, false],
    ['POST', '/api/kit-booking/execute', true, true, true, false],
    ['POST', '/api/invoices', true, true, false, false],
    ['PUT', '/api/client-orders/5', true, true, false, false],
    ['DELETE', '/api/bills/3', true, true, false, false],
    ['POST', '/api/suppliers', true, true, false, false],
    ['POST', '/api/projects', true, true, true, false],
    ['POST', '/api/projects/60/bom', true, true, true, false],
    ['DELETE', '/api/projects/60', true, true, false, false],
    ['POST', '/api/project-progress/60/stage', true, true, true, false],
    ['POST', '/api/qa-inspections', true, true, true, false],
    ['PUT', '/api/ncr/4', true, true, true, false],
    ['POST', '/api/automation-rules', true, true, false, false],
    ['DELETE', '/api/automation-rules/2', true, true, false, false],
  ])('%s %s', (method, p, ...expected) => {
    expect(who(method, p)).toEqual(expected);
  });

  it('lets everyone signed in read, sign out, log, look up prices and check kits', () => {
    for (const [method, p] of [['GET', '/api/invoices'], ['POST', '/api/session/logout'], ['POST', '/api/activity-log'],
      ['POST', '/api/pricing/quote'], ['POST', '/api/kit-booking/validate'], ['PUT', '/api/notifications/3/mark-read'],
      ['POST', '/api/settings']] as const) {
      expect(who(method, p), `${method} ${p}`).toEqual([true, true, true, true]);
    }
  });

  it('says who may, and refuses an area nobody listed to viewers only', () => {
    const res: any = { statusCode: 200, body: null, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
    requireWriteAccess({ method: 'POST', baseUrl: '/api', path: '/invoices', user: { role: 'engineer' } }, res, vi.fn());
    expect(res).toMatchObject({ statusCode: 403, body: { error: 'Only admins and managers can change bookkeeping (customers, quotes, orders, invoices, bills, payments).' } });
    expect(who('POST', '/api/something-new')).toEqual([true, true, true, false]);
  });

  it('leaves calls without a user to the sign-in check', () => {
    const next = vi.fn();
    requireWriteAccess({ method: 'POST', baseUrl: '/api', path: '/login' }, {} as any, next);
    requireWriteAccess({ method: 'POST', baseUrl: '/api', path: '/invoices' }, {} as any, next);
    expect(next).toHaveBeenCalledTimes(2);
  });
});
