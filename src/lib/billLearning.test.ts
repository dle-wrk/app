import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ pool: {}, query: vi.fn(), queryOne: vi.fn(), exec: vi.fn() }));

import { alignLines, applyProfile, invoiceShape, learnProfile, lineKey, type Example } from './billLearning';
import type { BillOcr } from './billOcr';
import { permissionForWrite } from './writeAccess';

const read = (over: Partial<BillOcr> = {}): BillOcr => ({
  supplier: 'Acme Parts (Pty) Ltd', supplierVatNumber: '4090109978', supplierAddress: null, supplierPhone: null, supplierEmail: null, supplierWebsite: null,
  invoiceNumber: '153667', date: '2026-11-20', dueDate: null, poNumber: null, currency: 'ZAR', subtotal: 1037, taxTotal: 155.55, total: 1192.5,
  lineItems: [
    { description: 'ENCLOSURE ABS MINIATURE PLASTIC', partNumber: '1551USB3TSK', quantity: 4, unitPrice: 61, lineTotal: 244 },
    { description: 'LIQUID FLUX FOR SMD COMPONENTS', partNumber: 'S00ML', quantity: 1, unitPrice: 49.5, lineTotal: 49.5 },
    { description: 'Delivery fee', partNumber: null, quantity: 1, unitPrice: 85, lineTotal: 85 },
  ],
  text: 'Acme Parts invoice SO - 153667 dated 20-Nov-2026', ...over,
});
// What was saved: the person chose stock items, tidied descriptions, picked accounts and VAT rates.
const example: Example = {
  ocr: read(),
  saved: {
    supplierInvoiceNumber: 'SO-153667', billDate: '2026-11-20', dueDate: '2026-12-20',
    lines: [
      { description: 'USB enclosure 65x30x15.5', partNumber: 'ENC-USB-01', quantity: 4, unitPrice: 61, accountId: 12, taxRateId: 1 },
      { description: 'Liquid flux 500 ml', partNumber: 'FLUX-500', quantity: 1, unitPrice: 49.5, accountId: 12, taxRateId: 1 },
      { description: 'Courier', partNumber: null, quantity: 1, unitPrice: 85, accountId: 30, taxRateId: 1 },
    ],
  },
};

describe('learning a supplier from the bills saved from its invoices', () => {
  it('pairs each read line with the saved line it became: by position, else by quantity and price, else by words', () => {
    expect(alignLines(example.ocr.lineItems, example.saved.lines).map(([r, s]) => [r.partNumber, s.partNumber])).toEqual([['1551USB3TSK', 'ENC-USB-01'], ['S00ML', 'FLUX-500'], [null, null]]);
    const fewer = alignLines(example.ocr.lineItems.slice(1), example.saved.lines);
    expect(fewer.map(([, s]) => s.description)).toEqual(['Liquid flux 500 ml', 'Courier']);
  });

  it("learns each code's stock item, description, account and VAT rate; the invoice number's shape; the due days", () => {
    const p = learnProfile([example]);
    expect(p.bills).toBe(1);
    expect(p.lines[lineKey({ partNumber: '1551USB3TSK' })]).toMatchObject({ item: 'ENC-USB-01', description: 'USB enclosure 65x30x15.5', accountId: 12, taxRateId: 1 });
    expect(p.lines[lineKey({ description: 'Delivery fee' })]).toMatchObject({ item: null, description: 'Courier', accountId: 30 });
    expect(p.invoiceShape).toEqual({ prefix: 'SO-', digits: 6 });
    expect(p.dueDays).toBe(30);
    expect(invoiceShape('INV/2026/0042')).toBeNull();
    expect(invoiceShape('88123')).toEqual({ prefix: '', digits: 5 });
  });

  it('the newest bill wins where they differ, and a line seen on several counts them', () => {
    const newer: Example = { ...example, saved: { ...example.saved, lines: [{ ...example.saved.lines[0], partNumber: 'ENC-USB-02' }, ...example.saved.lines.slice(1)] } };
    const p = learnProfile([newer, example]);
    expect(p.lines[lineKey({ partNumber: '1551USB3TSK' })]).toMatchObject({ item: 'ENC-USB-02', seen: 2 });
  });
});

describe("the supplier's next invoice, filled in from what was learned", () => {
  const p = learnProfile([example]);
  it('known lines get their stock item, description, account and VAT rate; new ones the usual account', () => {
    const next = read({ lineItems: [
      { description: 'ENCLOSURE ABS MINIATURE PLASTIC', partNumber: '1551USB3TSK', quantity: 10, unitPrice: 61, lineTotal: 610 },
      { description: 'SOMETHING NEW', partNumber: 'NEW-1', quantity: 1, unitPrice: 5, lineTotal: 5 },
    ] });
    const a = applyProfile(next, p)!;
    expect(a.learnedFrom).toBe(1);
    expect(a.lines).toEqual([
      { item: 'ENC-USB-01', description: 'USB enclosure 65x30x15.5', accountId: 12, taxRateId: 1, learned: true },
      { item: null, description: null, accountId: 12, taxRateId: 1, learned: false },
    ]);
  });

  it('puts back an invoice number prefix the reader lost, or finds the number in the text', () => {
    expect(applyProfile(read({ invoiceNumber: '153999', text: '' }), p)!.invoiceNumber).toBe('SO-153999');
    expect(applyProfile(read({ invoiceNumber: null, text: 'Invoice S0 154001 date' }), p)!.invoiceNumber).toBe('SO-154001');
    expect(applyProfile(read({ invoiceNumber: 'SO-154002' }), p)!.invoiceNumber).toBe('SO-154002');
  });

  it('nothing learned: nothing added', () => {
    expect(applyProfile(read(), null)).toBeNull();
    expect(applyProfile(read(), learnProfile([]))).toBeNull();
  });

  it('teaching and forgetting are bookkeeping', () => {
    expect(permissionForWrite('POST', '/api/bills/4/learn')).toBe('orders.update');
    expect(permissionForWrite('POST', '/api/bills/read-profiles/7/clear')).toBe('orders.update');
  });
});
