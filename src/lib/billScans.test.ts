import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ pool: {}, query: vi.fn(), queryOne: vi.fn(), exec: vi.fn() }));

import { normaliseBillOcr, ocrWarnings, tidyVatNumber, type BillOcr } from './billOcr';
import { billPages, checkPages, codeKey, companyKey, matchSupplier, missingProposals, newSupplierFrom, poKey } from './billScans';
import { permissionForWrite } from './writeAccess';
import { prefillFromBillScan, splitLeadingCode, type BillScan } from '../components/bookkeeping/BillInbox';

const ocr = (over: Partial<BillOcr> = {}): BillOcr => ({
  supplier: 'Mouser Electronics', supplierVatNumber: '4123456789', supplierAddress: '1 Main Rd, Midrand', supplierPhone: '011 555 0100',
  supplierEmail: 'za@mouser.example', supplierWebsite: 'mouser.co.za', invoiceNumber: 'INV-88123', date: '2026-11-10', dueDate: null,
  poNumber: 'PO-2026-0031', currency: 'ZAR', subtotal: 1000, taxTotal: 150, total: 1150,
  lineItems: [{ description: '10uF 0603', partNumber: 'CL10A106KP8NNNC', quantity: 4000, unitPrice: 0.25, lineTotal: 1000 }], text: '', ...over,
});

describe('reading an invoice', () => {
  it('tidies what the model returns, and drops what is unusable', () => {
    const o = normaliseBillOcr({
      supplier: '  Mouser   Electronics ', supplierVatNumber: 'VAT No: 4123 456 789', supplierEmail: 'Not an email', invoiceNumber: 'INV-1',
      date: '2026-11-10', dueDate: '10/12/2026', currency: 'zar', total: 'R 1 150.00', lineItems: [{ description: 'x', quantity: '2', unitPrice: 5, lineTotal: 10 }, { description: '', lineTotal: 0 }],
    });
    expect(o).toMatchObject({ supplier: 'Mouser Electronics', supplierVatNumber: '4123456789', supplierEmail: null, date: '2026-11-10', dueDate: null, currency: 'ZAR', total: 1150 });
    expect(o.lineItems).toEqual([{ description: 'x', partNumber: null, quantity: 2, unitPrice: 5, lineTotal: 10 }]);
    expect(tidyVatNumber('4123-456.789')).toBe('4123456789');
    expect(tidyVatNumber('N/A')).toBeNull();
  });

  it("says what doesn't add up", () => {
    expect(ocrWarnings(ocr())).toEqual([]);
    expect(ocrWarnings(ocr({ total: 1200 })).join(' ')).toContain("doesn't equal the total");
    expect(ocrWarnings(ocr({ taxTotal: 100, total: 1100 })).join(' ')).toContain("isn't 15%");
    expect(ocrWarnings(ocr({ lineItems: [{ description: 'a', partNumber: null, quantity: 1, unitPrice: 500, lineTotal: 500 }] })).join(' ')).toContain('a line may be missing');
    expect(ocrWarnings(ocr({ supplierVatNumber: null })).join(' ')).toContain('no supplier VAT number');
  });
});

describe('a bill sent from the scanner', () => {
  const jpeg = 'data:image/jpeg;base64,' + 'A'.repeat(100);
  it('takes photos only, up to 8 pages', () => {
    expect(checkPages([jpeg, jpeg])).toHaveLength(2);
    expect(() => checkPages([])).toThrow('photo of the bill');
    expect(() => checkPages(Array(9).fill(jpeg))).toThrow('Up to 8');
    expect(() => checkPages(['data:application/pdf;base64,AAAA'])).toThrow("isn't a photo");
    expect(() => checkPages(['data:image/jpeg;base64,' + 'A'.repeat(9_000_000)])).toThrow('too large');
  });

  it('finds the supplier by VAT number first, then by name', () => {
    const suppliers = [{ id: '1', name: 'Mouser Electronics (Pty) Ltd', vat_number: null }, { id: '2', name: 'DigiKey', vat_number: '4123 456 789' }, { id: '3', name: 'LCSC', vat_number: null }];
    expect(matchSupplier({ supplier: 'Anything', supplierVatNumber: '4123456789' }, suppliers)).toEqual({ id: '2', name: 'DigiKey', by: 'vat' });
    expect(matchSupplier({ supplier: 'MOUSER ELECTRONICS', supplierVatNumber: null }, suppliers)).toEqual({ id: '1', name: 'Mouser Electronics (Pty) Ltd', by: 'name' });
    expect(matchSupplier({ supplier: 'Mouser', supplierVatNumber: null }, suppliers)?.id).toBe('1');
    expect(matchSupplier({ supplier: 'RS Components', supplierVatNumber: null }, suppliers)).toBeNull();
    expect(companyKey('The Mouser Co. (Pty) Ltd.')).toBe('mouser');
    expect(poKey(' po 2026-0031 ')).toBe('PO2026-0031');
  });

  it('reads the pages a bill already has, one or many', () => {
    expect(billPages(null)).toEqual([]);
    expect(billPages(jpeg)).toEqual([jpeg]);
    expect(billPages(JSON.stringify([jpeg, jpeg]))).toEqual([jpeg, jpeg]);
    expect(billPages('[broken')).toEqual([]);
  });

  it('fills the bill form from what was read and matched', () => {
    const scan = { id: 9, status: 'INBOX', pageCount: 1, thumb: jpeg, note: null, user: { id: 1, name: 'Sam' }, capturedAt: null, createdAt: '', read: { status: 'READ', error: null, at: null },
      ocr: ocr(), warnings: ['w'], billId: null, billNumber: null,
      match: { supplier: { id: '1', name: 'Mouser', by: 'vat' }, po: { id: 31, number: 'PO-2026-0031', supplierId: '1', status: 'SENT' }, dueDate: '2026-12-10', lines: [{ partNumber: 'CL10A106KP8NNNC', item: 'CAP-024' }] } } as unknown as BillScan;
    expect(prefillFromBillScan(scan, [jpeg])).toMatchObject({
      billScanId: 9, supplierId: '1', supplierInvoiceNumber: 'INV-88123', date: '2026-11-10', dueDate: '2026-12-10', purchaseOrderId: 31, total: 1150, receiptImage: jpeg,
      lineItems: [{ description: '10uF 0603', quantity: 4000, unitPrice: 0.25, partNumber: 'CAP-024' }], warnings: ['w'],
      supplierDetails: { vatNumber: '4123456789', phone: '011 555 0100' },
    });
  });

  it("a line that isn't one of our stock items keeps the supplier's part number as its SKU, the description as it was", () => {
    const scan = { id: 9, status: 'INBOX', pageCount: 1, thumb: jpeg, note: null, user: { id: 1, name: 'Sam' }, capturedAt: null, createdAt: '', read: { status: 'READ', error: null, at: null },
      ocr: ocr({ lineItems: [{ description: 'CIRC CON PLASTIC IP68 SCW LOCK', partNumber: 'XY-CC211-3P-1-1C', quantity: 10, unitPrice: 114, lineTotal: 1140 }] }), warnings: [], billId: null, billNumber: null,
      match: { supplier: null, po: null, dueDate: null, lines: [{ partNumber: 'XY-CC211-3P-1-1C', item: null }] } } as unknown as BillScan;
    expect(prefillFromBillScan(scan, [jpeg]).lineItems).toEqual([{ description: 'CIRC CON PLASTIC IP68 SCW LOCK', quantity: 10, unitPrice: 114, partNumber: 'XY-CC211-3P-1-1C', accountId: null, taxRateId: null }]);
  });

  it('compares part codes with look-alike letters counted the same', () => {
    expect(codeKey('XY-CC211-3P-I-1C')).toBe(codeKey('XY-CC211-3P-1-1C'));
    expect(codeKey('S500ML')).toBe(codeKey('5500ML'));
    expect(codeKey('CBT8380BL')).not.toBe(codeKey('CBT8380BK'));
  });
});

describe('filling in what existing bills miss', () => {
  const supplier = { id: '1', name: 'Mouser', vat_number: null, address: '', phone: '012 000 0000', contact_email: null, website: 'https://mouser.co.za' };
  it('offers only what is empty now, never a change to a value', () => {
    const p = missingProposals({ supplier_id: '1', supplier_invoice_number: null }, supplier, ocr(), null);
    expect(p.map(x => [x.key, x.value])).toEqual([['supplierInvoiceNumber', 'INV-88123'], ['vatNumber', '4123456789'], ['address', '1 Main Rd, Midrand'], ['email', 'za@mouser.example']]);
    expect(missingProposals({ supplier_id: '1', supplier_invoice_number: 'X1' }, { ...supplier, vat_number: '9', address: 'a', contact_email: 'e@x.y' }, ocr(), null)).toEqual([]);
  });
  it('offers a supplier for a bill that has none, when the invoice matches one', () => {
    expect(missingProposals({ supplier_id: null, supplier_invoice_number: 'X' }, null, ocr(), { id: '7', name: 'Mouser' })).toEqual([{ key: 'supplierId', target: 'bill', label: 'Supplier', current: null, value: '7' }]);
  });
  it('who may do what: anyone but viewers sends from the phone; using it is bookkeeping', () => {
    expect(permissionForWrite('POST', '/api/bill-scans')).toBe('staff');
    expect(permissionForWrite('POST', '/api/bills/inbox/3/attach')).toBe('orders.update');
    expect(permissionForWrite('POST', '/api/bills/4/fill-missing')).toBe('orders.update');
  });
});

describe('adding the supplier a scanned invoice is from', () => {
  it('needs a name, and tidies the rest', () => {
    expect(newSupplierFrom({ name: '  Conti  Mirage Store ', vatNumber: 'VAT 4020 267 262', phone: '', email: ' ', website: 'conti.co.za' }))
      .toEqual({ name: 'Conti Mirage Store', vatNumber: '4020267262', address: null, phone: null, email: null, website: 'conti.co.za' });
    expect(() => newSupplierFrom({ name: ' ' })).toThrow("Type the supplier's name.");
    expect(() => newSupplierFrom({ name: 'Conti', email: 'not mail' })).toThrow("isn't an email address");
  });
  it('is a bookkeeping change, with the supplier right checked by the route', () => {
    expect(permissionForWrite('POST', '/api/bills/inbox/3/add-supplier')).toBe('orders.update');
  });
});

describe("a supplier code on the front of a description", () => {
  it('is split off into the SKU / part number', () => {
    expect(splitLeadingCode('CEL4041549 - DATA CABLE ADAPTER')).toEqual({ partNumber: 'CEL4041549', description: 'DATA CABLE ADAPTER' });
    expect(splitLeadingCode('PROMO13 - SALES PROMOTION TRADERS AGENT')?.partNumber).toBe('PROMO13');
  });
  it('leaves a description that is only words, or has no dash after the first word', () => {
    expect(splitLeadingCode('new keypad labels')).toBeNull();
    expect(splitLeadingCode('DATA CABLE ADAPTER')).toBeNull();
    expect(splitLeadingCode('Rags - A Grade (5) /kg')).toBeNull();
    expect(splitLeadingCode('AC-5V6A')).toBeNull();
  });
});

it('a quantity printed on a code ("EZ9F3210 :: 1N") is left off the SKU', () => {
  const scan = { id: 1, ocr: { ...ocr(), lineItems: [{ description: 'Breaker', partNumber: 'EZ9F3210 :: 1N', quantity: 1, unitPrice: 5, lineTotal: 5 }] }, match: null, warnings: [] } as unknown as BillScan;
  expect(prefillFromBillScan(scan, []).lineItems[0].partNumber).toBe('EZ9F3210');
});
