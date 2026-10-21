import { describe, expect, it, vi } from 'vitest';

// The routes import ./db, which refuses to load without DATABASE_URL (CI has none).
vi.mock('./db', () => ({
  pool: { connect: async () => { throw new Error('no database in tests'); } },
  query: async () => { throw new Error('no database in tests'); },
  queryOne: async () => null,
  exec: async () => {},
}));

import { returnInvoiceStock } from './bookkeeping-routes';

/** A stand-in for the stock tables: a ledger of transactions and the stock on hand. */
function fakeDb(ledger: Array<{ part: string; qty: number; reference: string }>, stock: Record<string, number>) {
  const like = (ref: string, pattern: string) => new RegExp(`^${pattern.replace(/\\([\\%_])/g, '$1').replace(/[.*+?^${}()|[\]]/g, '\\$&').replace(/%/g, '.*')}$`).test(ref);
  return {
    ledger, stock,
    async query(sql: string, params: any[] = []) {
      if (/SUM\(qtychange\)/.test(sql)) {
        const net = new Map<string, number>();
        for (const t of ledger) if (t.reference === params[0] || like(t.reference, params[1])) net.set(t.part, (net.get(t.part) ?? 0) + t.qty);
        return { rows: [...net].map(([part, n]) => ({ part, net: String(n) })) };
      }
      if (/^SELECT name, stock FROM inventory/.test(sql)) return { rows: params[0] in stock ? [{ name: params[0], stock: stock[params[0]] }] : [] };
      if (/^UPDATE inventory SET stock/.test(sql)) { stock[params[1]] += params[0]; return { rows: [] }; }
      if (/INSERT INTO transactions/.test(sql)) { ledger.push({ part: params[1], qty: params[4], reference: params[5] }); return { rows: [] }; }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

describe('voiding an invoice puts its stock back', () => {
  it('returns what the ledger says it took, and nothing the second time', async () => {
    const db = fakeDb([
      { part: 'CAP-024', qty: -100, reference: 'Invoice INV-2026-0003' },
      { part: 'RES-033', qty: -18, reference: 'Invoice INV-2026-0003' },
      { part: 'CAP-024', qty: -5, reference: 'Invoice INV-2026-0030' }, // another invoice, not this one
    ], { 'CAP-024': 1000, 'RES-033': 50 });
    expect(await returnInvoiceStock(db, 'INV-2026-0003', '— voided, stock returned')).toEqual([{ partNumber: 'CAP-024', qty: 100 }, { partNumber: 'RES-033', qty: 18 }]);
    expect(db.stock).toEqual({ 'CAP-024': 1100, 'RES-033': 68 });
    expect(db.ledger.at(-1)).toEqual({ part: 'RES-033', qty: 18, reference: 'Invoice INV-2026-0003 — voided, stock returned' });
    expect(await returnInvoiceStock(db, 'INV-2026-0003', '— voided, stock returned')).toEqual([]);
    expect(db.stock).toEqual({ 'CAP-024': 1100, 'RES-033': 68 });
  });

  it('an invoice revised after sending: returns its first booking-out once, so sending it again takes the new lines only', async () => {
    const db = fakeDb([{ part: 'LED-005', qty: -40, reference: 'Invoice INV-1' }], { 'LED-005': 60 });
    await returnInvoiceStock(db, 'INV-1', '— revised, stock returned');
    db.ledger.push({ part: 'LED-005', qty: -30, reference: 'Invoice INV-1' }); db.stock['LED-005'] -= 30; // sent again with 30
    expect(await returnInvoiceStock(db, 'INV-1', '— voided, stock returned')).toEqual([{ partNumber: 'LED-005', qty: 30 }]);
    expect(db.stock['LED-005']).toBe(100);
  });

  it('a draft that never took stock returns nothing', async () => {
    const db = fakeDb([], { 'CAP-024': 10 });
    expect(await returnInvoiceStock(db, 'INV-9', '— voided, stock returned')).toEqual([]);
  });
});
