import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ pool: {}, query: vi.fn(), queryOne: vi.fn(), exec: vi.fn() }));

import { amountsIn, findDate, parseBillLines, parseBillText, pricesIn, tidyNumbers } from './localOcr';

// An invoice's middle page: the item table (row: number, code, price; next lines: description and "xN"), then the totals.
const ITEMS = [
  'N/A N/A',
  ' # Name Unit Price',
  'ai LLL JOR 1 CLR',
  '1 1551USB3TSK 11 AN R61,00',
  'ENCLOSURE ABS MINIATURE PLASTIC x4',
  '65X30X15.5MM FOR USB',
  '3 CAB HDF195:: IN R18,20',
  'COAXIAL CABLE LOW LOSS x 30',
  '4 LIQUID FLUX S00ML :: 1N R49, 50',
  'LIQUID FLUX FOR SMD COMPONENTS x1',
  '€ CETEB380BL i: 50N R197,.50',
  'CABLE TIE 388MM X 7,8MM T120R X31',
  'Our Banking Detalles Sub-Total R1 037,00',
  'a/c Mo. 1084804371 ; Extra Charges: R0,00',
  'VAT: R155,55',
  '[edb ank, Business | Round Off: -R0O,05',
  'Brench Code. 186786 Grand Teta: __R1 192,50',
].join('\n');
import { normaliseBillOcr, ocrWarnings, readerOrder } from './billOcr';
import { domainLabel, matchSupplier } from './billScans';

// Text as Tesseract gives it from phone photos (made-up suppliers, laid out like real slips, with real misreads).
const SLIP = [
  'rd L',
  'k SCOoOMmMmumcq «.. HEAD OFFicE',
  'VAT Reg: 4090109978 Tel: (012) 657 3500',
  'Fax: (012) 657 3550',
  'Acme Parts (Pty) Ltd. Email: sales@acme €o.2a',
  'Wabsite, WWW.acmeparts.co,za',
  'TAX INVOICE',
  'Invoice Date/Time: :',
  '20-Nov-2026 09:57 am invoice No',
  'Ordered By: Your Ref:',
  'N/A N/A',
  '2 XY-CC211-3P-I-1C 1: IN R114,00',
  'CABLE END RECPT 3 POL MALE 30A',
  ': S00VAC',
  'Our Banking Details | Sub-Total R2 268,00',
  'Acme Parts (Pty) Lid ‘Extra Charges: RO,00',
  'Alc No 1034504371 VAT: R340,34',
  'Round Off. "R0,04',
  'Banking Midrand : Grand Total: R2 608,20',
].join('\n');
const INVOICE = [
  '| |',
  'i El',
  'https: //mww. widgetco.co.za py so',
  'emal info@widgetco.co.za invoice 153667',
  'tel +27 12 653 6820/6234 date 18/11/2026',
  'VAT # 4820251371',
  'billing address Cash Sale Centurion',
  'sales rep due date pay',
  'Henk Brits 18/12/2026 Debit Card Fay',
  'Cable Label Clips / Cable 2 R 75,65217 Taxable R 151,30',
  'SUB-TOTAL R 151.30',
  'VAT R22.70',
  'TOTAL R 174,00',
  'PAID R 174.00',
  'BALANCE R 0,00',
  'Acc Holder : WidgetCo CC',
].join('\n');

describe("Tracklab's own reader: picking fields out of the text", () => {
  it('reads dates written several ways, day before month', () => {
    expect(findDate('20-Nov-2026 09:57 am')).toBe('2026-11-20');
    expect(findDate('date 18/11/2026')).toBe('2026-11-18');
    expect(findDate('2026-11-05')).toBe('2026-11-05');
    expect(findDate('5 Dec 26')).toBe('2026-12-05');
    expect(findDate('Nov 3, 2026')).toBe('2026-11-03');
    expect(findDate('31/02/2026 or 1/3/2026')).toBe('2026-03-01'); // 31 Feb isn't a date
    expect(findDate('no date here 123')).toBeNull();
  });

  it('reads amounts with cents, either decimal mark, with or without thousands spaces', () => {
    expect(amountsIn('Grand Total: R2 608,20')).toEqual([2608.2]);
    expect(amountsIn('TOTAL R 174,00 and 1,554.50')).toEqual([174, 1554.5]);
    expect(amountsIn('Qty 2 code 4820251371')).toEqual([]);
  });

  it('a till slip: company with its suffix, VAT number, website, date, and totals from their own labels', () => {
    const o = normaliseBillOcr(parseBillText(SLIP));
    expect(o).toMatchObject({
      supplier: 'Acme Parts (Pty) Ltd', supplierVatNumber: '4090109978', supplierPhone: '(012) 657 3500',
      supplierEmail: null, // misread: left out rather than kept wrong
      supplierWebsite: 'www.acmeparts.co.za', date: '2026-11-20', invoiceNumber: null,
      poNumber: null, // "POL MALE" on a product line is not a PO
      subtotal: 2268, taxTotal: 340.34, total: 2608.2, currency: 'ZAR', lineItems: [],
    });
  });

  it('an invoice: email, invoice number, VAT number, due date, and the total (not the paid or balance line)', () => {
    const o = normaliseBillOcr(parseBillText(INVOICE));
    expect(o).toMatchObject({
      supplier: 'WidgetCo CC', supplierVatNumber: '4820251371', supplierEmail: 'info@widgetco.co.za', supplierPhone: '+27 12 653 6820',
      invoiceNumber: '153667', date: '2026-11-18', subtotal: 151.3, taxTotal: 22.7, total: 174,
    });
  });

  it("says it was read by the server's own reader, so every field gets checked", () => {
    const o = { ...normaliseBillOcr(parseBillText(INVOICE)), reader: 'local' as const };
    expect(ocrWarnings(o)[0]).toContain("Tracklab's own reader");
  });
});

describe("Tracklab's own reader: the invoice's lines", () => {
  it('tidies misread numbers', () => {
    expect(tidyNumbers('R49, 50 and R197,.50 and -R0O,04')).toBe('R49,50 and R197,50 and -R00,04');
    expect(pricesIn('Cable 2 R 75,65217 Taxable R 151,30')).toEqual([75.65217, 151.3]);
  });

  it('reads each item row as a line: code, description, quantity ("x4"), unit price, line total', () => {
    const o = parseBillText(ITEMS) as any;
    expect(o.lineItems).toEqual([
      { description: 'ENCLOSURE ABS MINIATURE PLASTIC 65X30X15.5MM FOR USB', partNumber: '1551USB3TSK', quantity: 4, unitPrice: 61, lineTotal: 244 },
      { description: 'COAXIAL CABLE LOW LOSS', partNumber: 'HDF195', quantity: 30, unitPrice: 18.2, lineTotal: 546 },
      { description: 'LIQUID FLUX FOR SMD COMPONENTS', partNumber: 'S00ML', quantity: 1, unitPrice: 49.5, lineTotal: 49.5 },
      // "X31" misread for x1: the only quantity that makes the lines add up to the subtotal.
      { description: 'CABLE TIE 388MM X 7,8MM T120R', partNumber: 'CETEB380BL', quantity: 1, unitPrice: 197.5, lineTotal: 197.5 },
    ]);
    expect(o.subtotal).toBe(1037);
  });

  it('works the total out from its parts when its label was misread ("Grand Teta") or the figure was', () => {
    const o = parseBillText(ITEMS) as any;
    expect(o.taxTotal).toBe(155.55);
    expect(o.total).toBe(1192.5); // 1037.00 + 0 + 155.55 - 0.05
    const misread = parseBillText(ITEMS.replace('R1 192,50', 'R1 182,50')) as any; // 9 read as 8: VAT is 15% of the subtotal, so the parts win
    expect(misread.total).toBe(1192.5);
  });

  it('a row with its description, quantity and both prices on one line', () => {
    const lines = ['ITEM DESCRIPTION QUANTITY UNIT PRICE', '+00 Pack Network Cable Label Clips / Cable 2 R 75,65217 Taxable R 151,30', 'Markers 4-6mm For Wire Management.', 'SUB-TOTAL R 151.30'];
    expect(parseBillLines(lines, 151.3)).toEqual([{ description: 'Pack Network Cable Label Clips Cable Markers 4-6mm For Wire Management.', partNumber: null, quantity: 2, unitPrice: 75.65217, lineTotal: 151.3 }]);
  });

  it('no item table: no lines', () => {
    expect(parseBillLines(['TOTAL R 174,00'], 151.3)).toEqual([]);
  });
});

describe('the supplier from the web address', () => {
  it('takes the company part of an email or website, not free mail', () => {
    expect(domainLabel('info@widgetco.co.za')).toBe('widgetco');
    expect(domainLabel('https://www.widgetco.co.za/terms')).toBe('widgetco');
    expect(domainLabel('someone@gmail.com')).toBeNull();
  });
  it('finds "WIDGETCO" from widgetco.co.za when the name was misread', () => {
    const suppliers = [{ id: '4', name: 'WIDGET CO' }, { id: '5', name: 'ACME PARTS' }];
    expect(matchSupplier({ supplier: 'i El', supplierVatNumber: null, supplierEmail: 'info@widgetco.co.za', supplierWebsite: null }, suppliers)).toEqual({ id: '4', name: 'WIDGET CO', by: 'web' });
    expect(matchSupplier({ supplier: 'Acme Parts (Pty) Ltd', supplierVatNumber: null }, suppliers)).toEqual({ id: '5', name: 'ACME PARTS', by: 'name' });
  });
});

describe('the readers in order', () => {
  it("the server's own reader is always last, unless named first or turned off", () => {
    expect(readerOrder({})).toEqual(['local']);
    expect(readerOrder({ OPENAI_API_KEY: 'o' })).toEqual(['openai', 'local']);
    expect(readerOrder({ OPENAI_API_KEY: 'o', BILL_READER: 'local' })).toEqual(['local', 'openai']);
    expect(readerOrder({ OPENAI_API_KEY: 'o', BILL_READER_LOCAL: 'off' })).toEqual(['openai']);
  });
});
