import { describe, it, expect } from 'vitest';
import { extractSupplier, extractDate, extractTotal, extractLineItems } from './receiptOcr';

// These tests pin the receipt parser's real-world behaviour so schema drifts
// (a new currency symbol on the wire, a new date format from a supplier) are
// caught before they hit a user. They exercise the pure heuristics only —
// Tesseract's OCR pass is out of scope here.

describe('extractSupplier', () => {
  it('takes the first non-junk line from the top of a receipt', () => {
    const text = 'MICROROBOTICS\nDate: 12/08/2026\nBolts x10 R150.00';
    expect(extractSupplier(text)).toBe('MICROROBOTICS');
  });

  it('skips generic headers like TAX INVOICE', () => {
    const text = 'TAX INVOICE\nMANTECH ELECTRONICS\nInvoice No: 12345';
    expect(extractSupplier(text)).toBe('MANTECH ELECTRONICS');
  });

  it('skips phone-number-only lines', () => {
    const text = '011 555 1234\nCommunica CC\nOrder: X';
    expect(extractSupplier(text)).toBe('Communica CC');
  });

  it('returns null when nothing in the first six lines is name-like', () => {
    // A slip so junk-heavy every candidate line either matches the junk
    // regex or is nothing but digits/whitespace.
    expect(extractSupplier('TAX INVOICE\nreceipt #\nVAT NO 1234\n0000000\n     \n99999')).toBeNull();
  });

  it('ignores lines that are too short to be a business name', () => {
    const text = 'ok\nRS COMPONENTS\nsku: X-1';
    expect(extractSupplier(text)).toBe('RS COMPONENTS');
  });
});

describe('extractDate', () => {
  it('parses DD/MM/YYYY (ZA locale default)', () => {
    expect(extractDate('Purchased on 12/08/2026')).toBe('2026-08-12');
  });

  it('parses ISO YYYY-MM-DD verbatim', () => {
    expect(extractDate('Some header\nDate: 2026-08-12')).toBe('2026-08-12');
  });

  it('parses DD Month YYYY', () => {
    expect(extractDate('Issued 5 August 2026')).toBe('2026-08-05');
  });

  it('pins two-digit years into the 2000s', () => {
    expect(extractDate('12/08/26')).toBe('2026-08-12');
  });

  it('accepts dot and dash separators', () => {
    expect(extractDate('05.08.2026')).toBe('2026-08-05');
    expect(extractDate('05-08-2026')).toBe('2026-08-05');
  });

  it('returns null when no date is present', () => {
    expect(extractDate('just some words')).toBeNull();
  });
});

describe('extractTotal', () => {
  it('picks the number on the TOTAL line, ignoring subtotals above', () => {
    const text = 'Bolt R100.00\nSubtotal R100.00\nVAT R15.00\nTOTAL R115.00';
    expect(extractTotal(text)).toBe(115);
  });

  it('handles ZA locale comma decimals', () => {
    expect(extractTotal('TOTAL R230,50')).toBe(230.5);
  });

  it('handles R / ZAR / $ prefixes', () => {
    expect(extractTotal('TOTAL $19.99')).toBe(19.99);
    expect(extractTotal('TOTAL ZAR 999.00')).toBe(999);
  });

  it('prefers TOTAL over larger numbers earlier on the slip', () => {
    const text = 'Item R500.00\nVAT R75.00\nTOTAL R120.00';
    expect(extractTotal(text)).toBe(120);
  });

  it('falls back to the largest number when no TOTAL line is found', () => {
    expect(extractTotal('R10.00\nR40.00\nR25.00')).toBe(40);
  });

  it('understands GRAND TOTAL, BALANCE DUE, AMOUNT DUE', () => {
    expect(extractTotal('GRAND TOTAL: R230.00')).toBe(230);
    expect(extractTotal('Balance Due R55.50')).toBe(55.5);
    expect(extractTotal('AMOUNT DUE 42.00')).toBe(42);
  });

  it('returns null when no money-shaped numbers are present', () => {
    expect(extractTotal('thanks come again')).toBeNull();
  });
});

describe('extractLineItems', () => {
  it('pulls single-money lines as one-per-item', () => {
    const text = 'Widget R150.00\nBracket R80.00\nTOTAL R230.00';
    const items = extractLineItems(text);
    expect(items).toEqual([
      { description: 'Widget', quantity: 1, unitPrice: 150, lineTotal: 150 },
      { description: 'Bracket', quantity: 1, unitPrice: 80, lineTotal: 80 },
    ]);
  });

  it('extracts a leading "N x" quantity', () => {
    const items = extractLineItems('2 x Widget R150.00');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ description: 'Widget', quantity: 2, lineTotal: 150 });
  });

  it('extracts a trailing "x N" quantity', () => {
    const items = extractLineItems('Widget x 3   R60.00');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ description: 'Widget', quantity: 3, lineTotal: 60 });
  });

  it('splits unit and total when two money values are present', () => {
    // "@ R25.00" plus line total "R50.00" for quantity 2
    const items = extractLineItems('2 x Widget @ R25.00   R50.00');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ quantity: 2, unitPrice: 25, lineTotal: 50 });
  });

  it('drops summary lines (TOTAL, SUBTOTAL, VAT, BALANCE, etc.)', () => {
    const text = 'Bolt R100.00\nSubtotal R100.00\nVAT R15.00\nTOTAL R115.00\nChange R5.00';
    const items = extractLineItems(text);
    expect(items).toHaveLength(1);
    expect(items[0].description).toBe('Bolt');
  });

  it('ignores blank lines and receipt junk', () => {
    const text = 'MICROROBOTICS\n\nDate: 12/08/2026\nBolts R150.00\nSlip No 5548\nTOTAL R150.00';
    const items = extractLineItems(text);
    expect(items.map(i => i.description)).toEqual(['Bolts']);
  });

  it('returns empty when nothing looks like a line item', () => {
    expect(extractLineItems('TAX INVOICE\nVAT NO 1234\nTOTAL R230.00')).toEqual([]);
  });

  it('handles ZA locale comma decimals', () => {
    const items = extractLineItems('Widget R150,50\nBracket R80,25');
    expect(items).toHaveLength(2);
    expect(items[0].lineTotal).toBe(150.5);
    expect(items[1].lineTotal).toBe(80.25);
  });
});
