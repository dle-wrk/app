import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { parseDelimited } from './inventoryImport';
import { parseAmount, planProductImport, productsToCsv, readProductSheets, readProductTable } from './productImport';

describe('parseAmount', () => {
  it.each([
    [8827.89, 8827.89], ['8827.89', 8827.89], ['R 8 827,89', 8827.89], ['R8827,89', 8827.89], ['8,827.89', 8827.89],
    ['8.827,89', 8827.89], ['8,827', 8827], ['8827,5', 8827.5], ['1 234 567', 1234567], ['ZAR 99', 99], ['0', 0], ['12.345', 12.35],
  ])('reads %j as %d', (input, expected) => {
    expect(parseAmount(input)).toBe(expected);
  });

  it.each([['abc'], [''], ['1.2.3'], ['R'], [null], [NaN]])('gives null for %j', (input) => {
    expect(parseAmount(input)).toBeNull();
  });
});

describe('readProductTable', () => {
  const TABLE = [
    ['Production costs', '', '', ''],
    ['Model #', 'Description', 'Category', 'Prod. cost', 'Selling price', 'Margin %', 'Notes'],
    ['TCU-001-SAT', '24V Self Powered', 'TCU', '', 'R 8 827,89', '40%', ''],
    ['', 'no model here', '', '1', '', '', ''],
    ['NCU-005-SANC', '', 'NCU', '12 000', 'call us', '', 'quote pending'],
    ['tcu-001-sat', 'again', '', '', '', '', ''],
    ['', '', '', '', '', '', ''],
  ];

  it('finds the columns by header, wherever the header row is', () => {
    const t = readProductTable(TABLE) as any;
    expect(t.columns).toEqual(['description', 'category', 'productionCost', 'sellingPrice', 'notes']);
    expect(t.ignoredHeaders).toEqual(['Margin %']);
    expect(t.rows).toEqual([
      { line: 3, modelNumber: 'TCU-001-SAT', description: '24V Self Powered', category: 'TCU', sellingPrice: 8827.89 },
      { line: 5, modelNumber: 'NCU-005-SANC', category: 'NCU', productionCost: 12000, notes: 'quote pending' },
    ]);
  });

  it('says what it left out', () => {
    expect((readProductTable(TABLE) as any).notes).toEqual([
      'Row 4 has no model number, so it was left out.',
      'Row 5: selling price "call us" isn\'t an amount, so it was left out.',
      'Row 6: tcu-001-sat is also on row 3; only the first was used.',
    ]);
  });

  it('refuses a table with no model number column', () => {
    expect(readProductTable([['Name', 'Price'], ['x', '1']])).toEqual({ error: 'it has no model number column (a header such as "Model #" or "Model number").' });
  });

  it('uses the first sheet of a workbook that is a product list', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Notes about pricing'], ['Prices exclude VAT']]), 'Read me');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Model number', 'Selling price'], ['PWR-PCK-001', 4254.86]]), 'Prices');
    const read = XLSX.read(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }), { type: 'array' });
    const t = readProductSheets(read.SheetNames.map((name) => ({ name, rows: XLSX.utils.sheet_to_json<unknown[]>(read.Sheets[name], { header: 1, raw: true, defval: '' }) }))) as any;
    expect(t.sheetName).toBe('Prices');
    expect(t.rows).toEqual([{ line: 2, modelNumber: 'PWR-PCK-001', sellingPrice: 4254.86 }]);
  });
});

describe('planProductImport', () => {
  const EXISTING = [
    { id: 1, modelNumber: 'TCU-001-SAT', description: '24V Self Powered', category: 'TCU', productionCost: null, sellingPrice: 8827.89 },
    { id: 2, modelNumber: 'PWR-PCK-001', description: 'Power Pack', category: 'Power', productionCost: 2127.43, sellingPrice: 4254.86 },
  ];

  it('adds new model numbers, changes only what differs, and skips what matches', () => {
    const plan = planProductImport([
      { line: 2, modelNumber: 'tcu-001-sat ', productionCost: 5200, sellingPrice: 8827.89 },
      { line: 3, modelNumber: 'PWR-PCK-001', sellingPrice: 4254.861 },
      { line: 4, modelNumber: 'DON-004-SATD', description: 'New dongle', sellingPrice: 900 },
    ], EXISTING);
    expect(plan).toEqual([
      { line: 2, modelNumber: 'TCU-001-SAT', kind: 'changed', id: 1, set: { productionCost: 5200 }, before: { productionCost: null } },
      { line: 3, modelNumber: 'PWR-PCK-001', kind: 'unchanged', id: 2, set: {}, before: {} },
      { line: 4, modelNumber: 'DON-004-SATD', kind: 'new', id: null, set: { description: 'New dongle', sellingPrice: 900 }, before: {} },
    ]);
  });
});

describe('productsToCsv', () => {
  it('exports the catalogue in columns the import reads back unchanged', () => {
    const products = [
      { id: 1, modelNumber: 'TCU-001-SAT', description: 'Tracker, "single" axis', category: 'TCU', productionCost: null, sellingPrice: 8827.89, notes: '' },
      { id: 2, modelNumber: 'PWR-PCK-001', description: 'Power Pack', category: 'Power', productionCost: 2127.43, sellingPrice: 4254.86, notes: 'box' },
    ];
    const t = readProductTable(parseDelimited(productsToCsv(products))) as any;
    expect(planProductImport(t.rows, products).map((c) => c.kind)).toEqual(['unchanged', 'unchanged']);
  });
});
