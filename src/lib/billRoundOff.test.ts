import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({
  pool: { connect: async () => { throw new Error('no database in tests'); } },
  query: async () => { throw new Error('no database in tests'); },
  queryOne: async () => null,
  exec: async () => {},
}));

import { BillCreateSchema } from './bookkeeping-routes';
import { withRoundOff } from '../components/bookkeeping/BillsTab';
import { lineTotals, newEditableLine } from '../components/bookkeeping/LineItemsEditor';

const item = (over: Record<string, unknown>) => ({ description: 'x', quantity: 1, unitPrice: 100, taxRateId: 1, ...over });

describe('bill lines: a negative round-off or discount', () => {
  it('may be negative with no part number and no stock received', () => {
    expect(BillCreateSchema.safeParse({ items: [item({ unitPrice: 2268.9 }), item({ description: 'Round off', unitPrice: -0.05, taxRateId: null })] }).success).toBe(true);
  });
  it("may not carry a part number, receive stock, or outweigh the lines", () => {
    expect(BillCreateSchema.safeParse({ items: [item({}), item({ partNumber: 'CAP-1', unitPrice: -1 })] }).success).toBe(false);
    expect(BillCreateSchema.safeParse({ items: [item({}), item({ unitPrice: -1, receiveStock: true })] }).success).toBe(false);
    const over = BillCreateSchema.safeParse({ items: [item({ unitPrice: 10 }), item({ unitPrice: -50 })] });
    expect(over.success).toBe(false);
    expect(over.success ? '' : over.error.issues[0].message).toBe('The round-offs and discounts come to more than the lines.');
  });
});

describe('a bill read from an invoice comes to its total', () => {
  const VAT = [{ id: 1, rate: 15 }];
  // Communica: six lines before VAT, 2 268.90; VAT per line rounds to 340.35, the invoice says 340.34 and -0.04 round-off: 2 609.20.
  const lines = [[244, 1], [1140, 1], [546, 1], [49.5, 1], [91.9, 1], [197.5, 1]].map(([p, q]) => ({ ...newEditableLine(), description: 'x', unitPrice: p, quantity: q, taxRateId: 1 }));
  const total = (ls: any[]) => Math.round(ls.reduce((s, l) => s + lineTotals(l, VAT as any).lineTotal, 0) * 100) / 100;

  it('adds a "Round off" line (no VAT) for the few cents between them', () => {
    expect(total(lines)).toBe(2609.25);
    const out = withRoundOff(lines, 2609.2, VAT);
    expect(out).toHaveLength(7);
    expect(out[6]).toMatchObject({ description: 'Round off (to the invoice total)', quantity: 1, unitPrice: -0.05, taxRateId: null });
    expect(total(out)).toBe(2609.2);
  });
  it('adds nothing when they already agree, when the gap is too big to be rounding, or with no total', () => {
    expect(withRoundOff(lines, 2609.25, VAT)).toHaveLength(6);
    expect(withRoundOff(lines, 2500, VAT)).toHaveLength(6);
    expect(withRoundOff(lines, null, VAT)).toHaveLength(6);
  });
  it('a round-off can be up too', () => {
    expect(withRoundOff(lines, 2609.3, VAT)[6].unitPrice).toBe(0.05);
  });
});
