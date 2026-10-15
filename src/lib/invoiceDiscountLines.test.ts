import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({
  pool: { connect: async () => { throw new Error('no database in tests'); } },
  query: async () => { throw new Error('no database in tests'); },
  queryOne: async () => null,
  exec: async () => {},
}));

import { InvoiceCreateSchema } from './bookkeeping-routes';

const line = (over: Record<string, unknown>) => ({ description: 'x', quantity: 1, unitPrice: 100, taxRateId: 1, ...over });

describe('invoice lines: a package discount line', () => {
  it('may be negative when it has no part number', () => {
    const r = InvoiceCreateSchema.safeParse({ items: [line({ partNumber: 'INV-5K', unitPrice: 18500 }), line({ description: 'Solar Kit A discount (5%)', unitPrice: -925 })] });
    expect(r.success).toBe(true);
  });

  it('may not carry a part number, take stock, or outweigh the lines', () => {
    expect(InvoiceCreateSchema.safeParse({ items: [line({ partNumber: 'INV-5K', unitPrice: -5 })] }).success).toBe(false);
    expect(InvoiceCreateSchema.safeParse({ items: [line({ unitPrice: 100 }), line({ unitPrice: -5, deductStock: true })] }).success).toBe(false);
    const over = InvoiceCreateSchema.safeParse({ items: [line({ unitPrice: 100 }), line({ unitPrice: -150 })] });
    expect(over.success).toBe(false);
    expect(over.success ? '' : over.error.issues[0].message).toBe('The discounts come to more than the lines.');
  });
});
