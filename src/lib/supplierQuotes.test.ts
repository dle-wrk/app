import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({
  pool: { connect: async () => { throw new Error('no database in tests'); } },
  query: async () => { throw new Error('no database in tests'); },
  queryOne: async () => null,
  exec: async () => {},
}));

import { cheapestSupplier, priceLadder, splitSummary, type Ladder } from './supplierQuotes';
import { quoteLines, type QuoteDeps } from './supplierQuoteRoutes';

const lcsc: Ladder = { supplierPn: 'C1591', currency: 'USD', breaks: [{ qty: 100, price: 0.0079 }, { qty: 1000, price: 0.006 }], moq: 100, mult: 1, stock: 55700 };
const mouser: Ladder = { supplierPn: '187-CL10B104', currency: 'USD', breaks: [{ qty: 1, price: 0.13 }, { qty: 10, price: 0.041 }, { qty: 50, price: 0.028 }], moq: 1, mult: 1, stock: 0 };
const digikey: Ladder = { supplierPn: '1276-1000-1-ND', currency: 'ZAR', breaks: [{ qty: 1, price: 1.9 }, { qty: 10, price: 0.95 }, { qty: 100, price: 0.4 }], moq: 1, mult: 1, stock: 12000 };

describe('priceLadder', () => {
  it('charges the break for what is actually bought: raised to the minimum, or the next multiple', () => {
    expect(priceLadder(lcsc, 50, 16.7)).toMatchObject({ orderQty: 100, unit: 0.0079, totalZar: 13.19, note: 'Minimum order 100', enoughStock: true });
    expect(priceLadder(mouser, 60, 16.7)).toMatchObject({ orderQty: 60, unit: 0.028, enoughStock: false, note: null });
    expect(priceLadder({ ...digikey, mult: 25 }, 60, 1)).toMatchObject({ orderQty: 75, unit: 0.95, totalZar: 71.25, note: 'Sold in multiples of 25' });
    expect(priceLadder({ ...digikey, breaks: [] }, 10, 1)).toBeNull();
  });
});

describe('cheapestSupplier', () => {
  it('takes the lowest total among suppliers that can cover the quantity, else the lowest of all', () => {
    const q = { lcsc: priceLadder(lcsc, 50, 16.7)!, mouser: priceLadder(mouser, 50, 16.7)!, digikey: priceLadder(digikey, 50, 1)! };
    expect(cheapestSupplier(q)).toBe('lcsc'); // R13.19 (100 pcs) beats DigiKey R47.50
    expect(cheapestSupplier({ mouser: q.mouser, digikey: { error: 'down' } })).toBe('mouser'); // out of stock, but the only price
    expect(cheapestSupplier({ digikey: { error: 'down' } })).toBeNull();
  });

  it('sums a split', () => {
    const q = { lcsc: priceLadder(lcsc, 50, 16.7)!, digikey: priceLadder(digikey, 50, 1)! };
    expect(splitSummary([{ quotes: q, choice: 'lcsc' }, { quotes: {}, choice: null }])).toEqual({
      bySupplier: { lcsc: { lines: 1, totalZar: 13.19 } }, totalZar: 13.19, dearestZar: 47.5, unpriced: 1,
    });
  });
});

describe('quoteLines', () => {
  const fakes = (over: Partial<QuoteDeps> = {}) => {
    const calls: string[] = [];
    const deps: QuoteDeps = {
      fetchLadder: async (s, pn) => { calls.push(`${s} ${pn}`); return s === 'lcsc' ? lcsc : s === 'mouser' ? mouser : digikey; },
      cached: async () => null,
      remember: async () => {},
      allowed: async () => true,
      counted: async () => {},
      ratesToZar: async () => ({ USD: 16.7, ZAR: 1 }),
      pause: async () => {},
      ...over,
    };
    return { deps, calls };
  };

  it('asks once per supplier part number, and picks the cheapest per line', async () => {
    const { deps, calls } = fakes();
    const out = await quoteLines([
      { stockCode: 'CAP-001', supPns: ['187-CL10B104', '1276-1000-1-ND', 'C1591'], qty: 50 },
      { stockCode: 'CAP-002', supPns: ['N/A', 'N/A', 'C1591'], qty: 500 }, // same LCSC part
    ], deps);
    expect(calls).toEqual(['mouser 187-CL10B104', 'digikey 1276-1000-1-ND', 'lcsc C1591']);
    expect(out.map((l) => l.best)).toEqual(['lcsc', 'lcsc']);
    expect(out[1].quotes).toEqual({ lcsc: expect.objectContaining({ orderQty: 500, unit: 0.0079 }) });
  });

  it('uses a cached ladder, stops at the daily limit, and reports a supplier that fails or lacks a rate', async () => {
    const { deps, calls } = fakes({
      cached: async (s) => (s === 'lcsc' ? { ladder: lcsc } : null),
      allowed: async (s) => s !== 'mouser',
      fetchLadder: async (s) => { calls.push(s); if (s === 'digikey') throw new Error('DigiKey search failed: 401'); return null; },
    });
    const [line] = await quoteLines([{ stockCode: 'CAP-001', supPns: ['187-CL10B104', '1276-1000-1-ND', 'C1591'], qty: 50 }], deps);
    expect(calls).toEqual(['digikey']); // LCSC from the cache, Mouser not asked
    expect(line.quotes.mouser).toEqual({ error: "Today's mouser lookups are used up" });
    expect(line.quotes.digikey).toEqual({ error: 'DigiKey search failed: 401' });
    expect(line.best).toBe('lcsc');

    const noRate = fakes({ ratesToZar: async () => ({ ZAR: 1 }) });
    const [l2] = await quoteLines([{ stockCode: 'X', supPns: ['', '', 'C1591'], qty: 10 }], noRate.deps);
    expect(l2.quotes.lcsc).toEqual({ error: 'No exchange rate for USD' });
  });
});
