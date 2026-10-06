// @vitest-environment node
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { parseDelimited, planFromSheets, planFromTable, planToCsv } from './inventoryImport';

// The MainInventory workbook, cut down: a "Serial Numbers" grid first, then
// the real inventory sheet with its own column names and order.
const SERIAL_GRID = [
  ['CON-001', 'CHP-001', 'DIO-001', 'CAP-001'],
  ['CON-002', 'CHP-002', 'DIO-002', 'CAP-002'],
  ['CON-003', 'CHP-003', '', 'CAP-003'],
];
const WORKBOOK_HEADER = ['SerialNumber', 'Name', 'Description', 'Value', 'Size', 'Package', 'Tolerance', 'Type', 'Footprint', 'Comments',
  'Datasheet', 'Project', 'Packaging', 'Stock', 'QTY per PCB', 'LowStockLvl', 'Bulk Price $', 'Bulk Price R',
  'ManPN1', 'ManPN2', 'ManPN3', 'ManPN4', 'ManPN5', 'SupPN1', 'SupPN2', 'SupPN3', 'SupPN4', 'SupPN5',
  'WebLink1', 'WebLink2', 'WebLink3', 'WebLink4', 'WebLink5', ''];
const wbRow = (cells: Record<string, unknown>) => WORKBOOK_HEADER.map((h) => cells[h] ?? '');
const INVENTORY = [
  WORKBOOK_HEADER,
  wbRow({ SerialNumber: 'CON-002', Name: 'Molex Connector', Description: 'Connector Header 0.050" (1.27mm)', Stock: 80, 'QTY per PCB': 1, LowStockLvl: 50,
    'Bulk Price $': 0, 'Bulk Price R': 1.387, ManPN1: 'N/A', ManPN2: 'HX20007-5AWB', ManPN3: 'C442225', SupPN3: 'C442225', WebLink3: 'HX20007-5AWB | LCSC' }),
  wbRow({ SerialNumber: 'CON-010', Name: 'PCB HEADER', Description: 'Header straight 1x14 pins', 'QTY per PCB': 1 }),
  wbRow({ SerialNumber: 'CON-010', Name: 'duplicate' }),
  wbRow({ SerialNumber: 527 }),
];
const sheets = [{ name: 'Serial Numbers', rows: SERIAL_GRID }, { name: 'TrackLabInventory', rows: INVENTORY }];

describe('planFromSheets', () => {
  it('skips a first sheet that is not an inventory list and says which sheet it read', () => {
    const plan = planFromSheets(sheets);
    if ('error' in plan) throw new Error(plan.error);

    expect(plan.sheetName).toBe('TrackLabInventory');
    expect(plan.notes[0]).toBe('Read the sheet "TrackLabInventory". The first sheet, "Serial Numbers", is not an inventory list.');
    expect(plan.rows.map((r) => r.serial_number)).toEqual(['CON-002', 'CON-010']);
  });

  it('refuses a workbook with no inventory sheet, which is what the "Serial Numbers" sheet alone is', () => {
    expect(planFromSheets([sheets[0]])).toEqual({
      error: 'No sheet in this workbook is an inventory list. Its first row needs column names, including a part number column (serial_number or SerialNumber).',
    });
  });

  it('reads a real .xlsx file the same way', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(SERIAL_GRID), 'Serial Numbers');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(INVENTORY), 'TrackLabInventory');
    const read = XLSX.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });

    const plan = planFromSheets(read.SheetNames.map((name) => ({ name, rows: XLSX.utils.sheet_to_json<unknown[]>(read.Sheets[name], { header: 1, raw: true, defval: '' }) })));
    if ('error' in plan) throw new Error(plan.error);

    expect(plan.rows[0]).toMatchObject({ serial_number: 'CON-002', name: 'Molex Connector', stock: 80, bulk_price_zar: 1.387 });
  });
});

describe('planFromTable', () => {
  const plan = (() => { const p = planFromTable(INVENTORY, 'TrackLabInventory'); if ('error' in p) throw new Error(p.error); return p; })();
  const con002 = plan.rows[0];
  const con010 = plan.rows[1];

  it('maps the workbook’s own column names onto the right fields', () => {
    expect(con002).toMatchObject({
      serial_number: 'CON-002', name: 'Molex Connector', description: 'Connector Header 0.050" (1.27mm)',
      stock: 80, qty_per_pcb: 1, low_stock_lvl: 50, bulk_price_usd: 0, bulk_price_zar: 1.387,
    });
    expect(plan.columns).toEqual(expect.arrayContaining(['comment', 'qty_per_pcb', 'low_stock_lvl', 'bulk_price_usd', 'bulk_price_zar', 'man_pn_1', 'sup_pn_5', 'weblink_5']));
    expect(plan.columns).not.toContain('current_cost_dollar');
  });

  it('keeps part numbers and links in their slots, blanks included, when a row fills any in', () => {
    expect([1, 2, 3, 4, 5].map((i) => con002[`sup_pn_${i}`])).toEqual(['', '', 'C442225', '', '']);
    expect([1, 2, 3, 4, 5].map((i) => con002[`man_pn_${i}`])).toEqual(['N/A', 'HX20007-5AWB', 'C442225', '', '']);
    expect([1, 2, 3, 4, 5].map((i) => con002[`weblink_${i}`])).toEqual(['', '', 'HX20007-5AWB | LCSC', '', '']);
  });

  it('writes nothing for empty cells, so values on file are kept', () => {
    // CON-010 has no stock, prices, part numbers or links in the sheet.
    expect(con010).toEqual({ serial_number: 'CON-010', name: 'PCB HEADER', description: 'Header straight 1x14 pins', qty_per_pcb: 1 });
  });

  it('skips repeated part numbers and bare-number rows, and says so', () => {
    expect(plan.rows).toHaveLength(2);
    expect(plan.notes).toEqual([
      'Skipped 1 repeated part number (the first row for each is used): CON-010.',
      'Skipped 1 row whose part number is just a number (527), likely a total.',
    ]);
  });

  it('reads the app’s own export header too', () => {
    const p = planFromTable([['serial_number', 'name', 'stock', 'current_cost_dollar', 'status', 'color'], ['LED-001', 'Red LED', '12', '0.05', 'inactive', 'Red']]);
    if ('error' in p) throw new Error(p.error);

    expect(p.rows).toEqual([{ serial_number: 'LED-001', name: 'Red LED', stock: 12, current_cost_dollar: 0.05, status: 'INACTIVE', color: 'Red' }]);
  });

  it('writes a partial set of part-number columns as plain columns', () => {
    const p = planFromTable([['serial_number', 'sup_pn_3'], ['CON-014', 'C18221575']]);
    if ('error' in p) throw new Error(p.error);

    expect(p.rows).toEqual([{ serial_number: 'CON-014', sup_pn_3: 'C18221575' }]);
  });

  it('leaves a cell alone when its value does not fit the column', () => {
    const p = planFromTable([['serial_number', 'stock', 'status'], ['CON-001', '12.5', 'MAYBE'], ['CON-002', 'lots', 'ACTIVE']]);
    if ('error' in p) throw new Error(p.error);

    expect(p.rows).toEqual([{ serial_number: 'CON-001' }, { serial_number: 'CON-002', status: 'ACTIVE' }]);
    expect(p.notes).toEqual(['Left 3 cells unchanged because the value doesn\'t fit the column: CON-001 stock "12.5"; CON-001 status "MAYBE"; CON-002 stock "lots".']);
  });

  it('lists header cells it does not recognise', () => {
    const p = planFromTable([['SerialNumber', 'Name', 'Shelf'], ['CON-001', 'A', 'B4']]);
    if ('error' in p) throw new Error(p.error);

    expect(p.ignoredHeaders).toEqual(['Shelf']);
    expect(p.rows).toEqual([{ serial_number: 'CON-001', name: 'A' }]);
  });

  it('refuses a table with no part-number column', () => {
    expect(planFromTable(SERIAL_GRID)).toEqual({ error: 'The first row needs column names, including a part number column (serial_number or SerialNumber).' });
  });
});

describe('parseDelimited', () => {
  it('handles quoted fields holding the delimiter, quotes and line breaks', () => {
    expect(parseDelimited('serial_number;name;description\r\nCON-003;"JTAG; 10 pin";"0.050"" pitch\nSMD"\n')).toEqual([
      ['serial_number', 'name', 'description'],
      ['CON-003', 'JTAG; 10 pin', '0.050" pitch\nSMD'],
    ]);
  });

  it('falls back to commas when the header has no semicolon', () => {
    expect(parseDelimited('serial_number,name\nCON-001,Molex')).toEqual([['serial_number', 'name'], ['CON-001', 'Molex']]);
  });
});

describe('planToCsv', () => {
  it('writes exactly the batch, quoting where needed, and reads back the same', () => {
    const p = planFromTable([['serial_number', 'name', 'stock'], ['CON-003', 'JTAG; "10 pin"', '80']]);
    if ('error' in p) throw new Error(p.error);

    const csv = planToCsv(p);

    expect(csv).toBe('serial_number;name;stock\nCON-003;"JTAG; ""10 pin""";80\n');
    const again = planFromTable(parseDelimited(csv));
    expect(!('error' in again) && again.rows).toEqual(p.rows);
  });
});
