import { expect, it, vi } from 'vitest';

vi.mock('./db', () => ({
  pool: { connect: async () => { throw new Error('no database in tests'); } },
  query: async () => { throw new Error('no database in tests'); },
  queryOne: async () => null,
  exec: async () => {},
}));

import { returnDispatchStock } from './bookkeeping-routes';

/** Stock and its transactions, as a reopened note sees them. */
function stockDb(stock: Record<string, number>) {
  const trx: Array<{ part: string; qty: number; ref: string }> = [];
  return {
    stock, trx,
    async query(sql: string, params: any[] = []) {
      const s = sql.replace(/\s+/g, ' ');
      if (/SUM\(qtychange\)/.test(s)) {
        const like = new RegExp(`^${String(params[1]).replace(/\\/g, '').replace(/[.*+?^${}()|[\]]/g, '\\$&').replace(/%/g, '.*')}$`);
        const net = new Map<string, number>();
        for (const t of trx) if (t.ref === params[0] || like.test(t.ref)) net.set(t.part, (net.get(t.part) || 0) + t.qty);
        return { rows: [...net].map(([part, n]) => ({ part, net: n })) };
      }
      if (/SELECT name, stock FROM inventory/.test(s)) return { rows: params[0] in stock ? [{ name: params[0], stock: stock[params[0]] }] : [] };
      if (/^UPDATE inventory SET stock = stock \+/.test(s)) { stock[params[1]] += params[0]; return { rows: [] }; }
      if (/^INSERT INTO transactions/.test(s)) { trx.push({ part: params[1], qty: params[4], ref: params[5] }); return { rows: [] }; }
      throw new Error(`unexpected SQL: ${s}`);
    },
  };
}

it('reopening a note puts back what it booked out, once', async () => {
  const db = stockDb({ 'CAP-1': 90, 'RES-2': 5 });
  db.trx.push({ part: 'CAP-1', qty: -10, ref: 'Dispatch CN-2026-0008' }, { part: 'RES-2', qty: -5, ref: 'Dispatch CN-2026-0008' }, { part: 'CAP-1', qty: -3, ref: 'Dispatch CN-2026-0007' });
  expect(await returnDispatchStock(db, 'CN-2026-0008')).toEqual([{ partNumber: 'CAP-1', qty: 10 }, { partNumber: 'RES-2', qty: 5 }]);
  expect(db.stock).toEqual({ 'CAP-1': 100, 'RES-2': 10 });
  // Reopened again (completed, reopened twice without a new booking out): nothing more comes back.
  expect(await returnDispatchStock(db, 'CN-2026-0008')).toEqual([]);
  expect(db.stock).toEqual({ 'CAP-1': 100, 'RES-2': 10 });
});
