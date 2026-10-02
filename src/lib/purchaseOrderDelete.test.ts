// @vitest-environment node
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The real DELETE /api/purchase-orders/:id handler, registered on a real
// Express app, against a scripted stand-in for the database. Each test sets
// the purchase order row and the bills linked to it; every statement the
// handler runs is recorded so the tests can check what it did and did not do.

const db = vi.hoisted(() => ({
  po: null as null | { id: number; po_number: string; status: string; total: string },
  linkedBills: [] as { bill_number: string; status: string }[],
  statements: [] as { text: string; params: unknown[] }[],
  released: 0,
}));

vi.mock('./db', () => {
  const run = async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    db.statements.push({ text: sql, params });
    if (/^SELECT .* FROM purchase_orders WHERE id = \$1 FOR UPDATE$/i.test(sql)) {
      return { rows: db.po ? [db.po] : [], rowCount: db.po ? 1 : 0 };
    }
    if (/^UPDATE bills SET purchase_order_id = NULL/i.test(sql)) {
      return { rows: db.linkedBills, rowCount: db.linkedBills.length };
    }
    return { rows: [], rowCount: 0 };
  };
  return {
    pool: { connect: async () => ({ query: run, release: () => { db.released += 1; } }) },
    query: run,
    queryOne: async (text: string, params: unknown[] = []) => (await run(text, params)).rows[0] ?? null,
    exec: async () => {},
  };
});

import { registerBookkeepingRoutes } from './bookkeeping-routes';

let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Stand-in for attachSessionUser: the test names the caller's role.
  app.use('/api', (req: any, _res, next) => {
    const role = req.headers['x-test-role'];
    if (role) req.user = { id: 1, email: `${role}@example.com`, role: String(role) };
    next();
  });
  registerBookkeepingRoutes(app);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));

beforeEach(() => {
  db.po = null;
  db.linkedBills = [];
  db.statements = [];
  db.released = 0;
});

const deletePo = async (role?: string) => {
  const res = await fetch(`${base}/api/purchase-orders/6`, { method: 'DELETE', headers: role ? { 'x-test-role': role } : {} });
  return { status: res.status, body: await res.json() };
};
const ran = (pattern: RegExp) => db.statements.some((s) => pattern.test(s.text));
const order = (pattern: RegExp) => db.statements.findIndex((s) => pattern.test(s.text));

describe('DELETE /api/purchase-orders/:id', () => {
  it('lets an admin delete a received order, unlinking and reporting its bill', async () => {
    db.po = { id: 6, po_number: 'PO-2026-0006', status: 'RECEIVED', total: '3441.38' };
    db.linkedBills = [{ bill_number: 'BILL-2026-0005', status: 'PAID' }];

    const res = await deletePo('admin');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, unlinkedBills: [{ billNumber: 'BILL-2026-0005', status: 'PAID' }] });
    // The bill is unlinked before the order goes, and it all commits.
    expect(order(/^UPDATE bills SET purchase_order_id = NULL/)).toBeGreaterThan(-1);
    expect(order(/^DELETE FROM purchase_orders/)).toBeGreaterThan(order(/^UPDATE bills SET purchase_order_id = NULL/));
    expect(ran(/^COMMIT$/)).toBe(true);
    expect(ran(/^ROLLBACK$/)).toBe(false);
    expect(db.released).toBe(1);
  });

  it('records who deleted what in the activity log, inside the same transaction', async () => {
    db.po = { id: 6, po_number: 'PO-2026-0006', status: 'RECEIVED', total: '3441.38' };
    db.linkedBills = [{ bill_number: 'BILL-2026-0005', status: 'PAID' }];

    await deletePo('admin');

    const log = db.statements.find((s) => /^INSERT INTO user_activity_logs/.test(s.text));
    expect(log).toBeDefined();
    expect(log!.text).toContain("'DELETE_PURCHASE_ORDER'");
    expect(log!.params[0]).toBe('admin@example.com');
    expect(log!.params[1]).toBe('PO-2026-0006');
    expect(JSON.parse(String(log!.params[2]))).toEqual({ status: 'RECEIVED', total: '3441.38', unlinkedBills: ['BILL-2026-0005'] });
    expect(order(/^INSERT INTO user_activity_logs/)).toBeLessThan(order(/^COMMIT$/));
  });

  it('refuses a non-admin on anything past draft, and changes nothing', async () => {
    for (const status of ['SENT', 'PARTIAL', 'RECEIVED', 'CANCELLED']) {
      db.statements = [];
      db.po = { id: 6, po_number: 'PO-2026-0006', status, total: '10.00' };
      db.linkedBills = [{ bill_number: 'BILL-2026-0005', status: 'PAID' }];

      const res = await deletePo('user');

      expect(res.status, status).toBe(403);
      expect(res.body).toEqual({ error: `Only an admin can delete a purchase order that is ${status}.` });
      expect(ran(/^UPDATE bills/), status).toBe(false);
      expect(ran(/^DELETE FROM purchase_orders/), status).toBe(false);
      expect(ran(/^INSERT INTO user_activity_logs/), status).toBe(false);
      expect(ran(/^ROLLBACK$/), status).toBe(true);
    }
  });

  it('treats a caller with no role the same as a non-admin', async () => {
    db.po = { id: 6, po_number: 'PO-2026-0006', status: 'RECEIVED', total: '10.00' };

    const res = await deletePo();

    expect(res.status).toBe(403);
    expect(ran(/^DELETE FROM purchase_orders/)).toBe(false);
  });

  it('still lets a non-admin delete a draft', async () => {
    db.po = { id: 6, po_number: 'PO-2026-0009', status: 'DRAFT', total: '50.00' };

    const res = await deletePo('user');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, unlinkedBills: [] });
    expect(ran(/^DELETE FROM purchase_orders/)).toBe(true);
    expect(ran(/^COMMIT$/)).toBe(true);
  });

  it('answers 404 for an order that does not exist', async () => {
    const res = await deletePo('admin');

    expect(res.status).toBe(404);
    expect(ran(/^DELETE FROM purchase_orders/)).toBe(false);
    expect(ran(/^ROLLBACK$/)).toBe(true);
    expect(db.released).toBe(1);
  });
});
