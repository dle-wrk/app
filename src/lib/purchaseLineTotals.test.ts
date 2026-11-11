import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ pool: { connect: async () => { throw new Error('no database in tests'); } }, query: async () => ({ rows: [] }), queryOne: async () => null, exec: async () => {} }));

import { computeDocumentTotals, purchaseLineTotals } from './bookkeeping-db';

// BILL-2026-0008 (Chamberlains): prices entered including 15% VAT.
const bill = [91.9, 82.9, 105, 97, 97.9, 99];

describe('purchase lines entered including VAT', () => {
  it('keeps the price you typed as the line total and stores the cost ex VAT', () => {
    const l = purchaseLineTotals({ description: 'Drillbit', quantity: 1, unitPrice: 91.9, taxRatePercent: 15, taxInclusive: true });
    expect(l).toEqual({ base: 79.91, taxAmount: 11.99, lineTotal: 91.9, unitPrice: 79.91 });
  });

  it('the whole Chamberlains bill comes to what was paid, not 15% more', () => {
    const lines = bill.map((p) => purchaseLineTotals({ description: 'x', quantity: 1, unitPrice: p, taxRatePercent: 15, taxInclusive: true }));
    expect(computeDocumentTotals(lines).total).toBe(573.7);
    // and the journal's expense debit (qty × stored cost) still matches the base, so it balances
    for (const l of lines) expect(Math.round(l.unitPrice * 100) / 100).toBe(l.base);
  });

  it('several units: the ex-VAT unit cost times the quantity gives the base to the cent', () => {
    const l = purchaseLineTotals({ description: 'x', quantity: 7, unitPrice: 33.33, taxRatePercent: 15, taxInclusive: true });
    expect(l.lineTotal).toBe(233.31);
    expect(Math.round(7 * l.unitPrice * 100) / 100).toBe(l.base);
  });

  it('exclusive lines, and inclusive with no tax, are unchanged', () => {
    expect(purchaseLineTotals({ description: 'x', quantity: 1, unitPrice: 91.9, taxRatePercent: 15 })).toEqual({ base: 91.9, taxAmount: 13.79, lineTotal: 105.69, unitPrice: 91.9 });
    expect(purchaseLineTotals({ description: 'x', quantity: 2, unitPrice: 10, taxRatePercent: 0, taxInclusive: true }).unitPrice).toBe(10);
  });
});
