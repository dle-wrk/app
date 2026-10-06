// Reads a spreadsheet or CSV file for the inventory import (Items >
// Import), and works out exactly what it would write.
//
// The old reader took the FIRST sheet of a workbook and read every column
// by position. MainInventory.xlsx starts with a "Serial Numbers" sheet (a
// grid of part numbers per category), so importing it wrote "CHP-002",
// "DIO-002"... into the name and description of CON-002..CON-023 and set
// their stock to 0. Reading by position also mixed up the workbook's own
// inventory sheet, whose columns after "LowStockLvl" are in a different
// order, and every import blanked part numbers 2-5, the web links and the
// colour of each row, whatever the file held.
//
// So now:
//  - columns are found by their header names, and a sheet whose first row
//    has no part-number column is not an inventory list: it is refused,
//    and in a workbook the first sheet that IS one is used;
//  - only the columns the file has are written, and an empty cell leaves
//    the value on file alone (a sheet with no web links, or a blank stock
//    cell, no longer wipes anything);
//  - when a file has all five manufacturer part numbers, supplier part
//    numbers or web links, a row that fills in any of them has all five
//    written, blanks included, since the slot matters (supplier slot 1 is
//    Mouser, 2 DigiKey, 3 LCSC); a row that leaves all five empty keeps
//    what is on file;
//  - quoted CSV fields may hold the delimiter.

export type ImportValue = string | number;
export type ImportRow = { serial_number: string } & Record<string, ImportValue>;

export interface ImportPlan {
  /** The workbook sheet read, or null for a CSV file. */
  sheetName: string | null;
  /** Columns the file provides, besides the part number. */
  columns: string[];
  /** Header cells that matched no inventory column, shown so nothing is silently dropped. */
  ignoredHeaders: string[];
  /** One payload per part, ready for POST /api/items/bulk. */
  rows: ImportRow[];
  /** Plain-language notes about rows or cells that were skipped. */
  notes: string[];
}

const SLOT_GROUPS = ['man_pn', 'sup_pn', 'weblink'] as const;
const INTEGER_COLUMNS = new Set(['stock', 'low_stock_lvl', 'last_order_qty']);
const NUMBER_COLUMNS = new Set(['qty_per_pcb', 'current_cost_dollar', 'bulk_price_usd', 'bulk_price_zar']);
const STATUSES = ['ACTIVE', 'INACTIVE', 'BOOKED OUT', 'DISCONTINUED'];

// Header names, lower-cased with spaces, underscores, dashes and dots
// removed. Covers the app's own export/template (serial_number;name;...)
// and the MainInventory workbook (SerialNumber, Comments, QTY per PCB,
// LowStockLvl, Bulk Price $, Bulk Price R, ManPN1, SupPN1, WebLink1...).
const HEADER_ALIASES: Record<string, string> = {
  serialnumber: 'serial_number', partnumber: 'serial_number', stockcode: 'serial_number', sku: 'serial_number',
  name: 'name', description: 'description', value: 'value', size: 'size', package: 'package',
  tolerance: 'tolerance', type: 'type', footprint: 'footprint', comment: 'comment', comments: 'comment',
  datasheet: 'datasheet', project: 'project', packaging: 'packaging',
  stock: 'stock', stocklevel: 'stock',
  qtyperpcb: 'qty_per_pcb', lowstocklvl: 'low_stock_lvl', lowstocklevel: 'low_stock_lvl',
  currentcostdollar: 'current_cost_dollar', currentcost: 'current_cost_dollar',
  bulkpriceusd: 'bulk_price_usd', 'bulkprice$': 'bulk_price_usd',
  bulkpricezar: 'bulk_price_zar', bulkpricer: 'bulk_price_zar',
  lastorderqty: 'last_order_qty', lastorderdate: 'last_order_date',
  status: 'status', color: 'color', colour: 'color',
};
for (const i of [1, 2, 3, 4, 5]) {
  HEADER_ALIASES[`manpn${i}`] = `man_pn_${i}`;
  HEADER_ALIASES[`suppn${i}`] = `sup_pn_${i}`;
  HEADER_ALIASES[`weblink${i}`] = `weblink_${i}`;
}

const headerKey = (h: unknown) => String(h ?? '').toLowerCase().replace(/[\s_\-.]/g, '');
const cellText = (v: unknown) => (v == null ? '' : String(v).trim());

/** Splits CSV text into rows of cells. Detects ';' or ',' from the first line. */
export function parseDelimited(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const delim = firstLine.includes(';') ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === delim) {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Works out what importing one table (header row first) would write. */
export function planFromTable(table: unknown[][], sheetName: string | null = null): ImportPlan | { error: string } {
  const body = table.filter((r) => Array.isArray(r) && r.some((c) => cellText(c) !== ''));
  if (body.length === 0) return { error: 'The file is empty.' };
  const header = body[0].map((h) => cellText(h));

  const columnAt = new Map<number, string>();
  const ignoredHeaders: string[] = [];
  header.forEach((h, i) => {
    if (!h) return;
    const column = HEADER_ALIASES[headerKey(h)];
    if (!column || [...columnAt.values()].includes(column)) ignoredHeaders.push(h);
    else columnAt.set(i, column);
  });
  const serialAt = [...columnAt].find(([, c]) => c === 'serial_number')?.[0];
  if (serialAt === undefined) {
    return { error: 'The first row needs column names, including a part number column (serial_number or SerialNumber).' };
  }
  const columns = [...new Set([...columnAt.values()].filter((c) => c !== 'serial_number'))];
  if (columns.length === 0) return { error: 'Besides the part number, none of the columns are inventory fields.' };
  const fullGroups = SLOT_GROUPS.filter((g) => [1, 2, 3, 4, 5].every((i) => columns.includes(`${g}_${i}`)));
  const inFullGroup = (column: string) => fullGroups.some((g) => column.startsWith(`${g}_`));

  const rows: ImportRow[] = [];
  const seen = new Set<string>();
  const duplicates: string[] = [];
  const numericParts: string[] = [];
  const badCells: string[] = [];
  for (const raw of body.slice(1)) {
    const serial = cellText(raw[serialAt]);
    if (!serial) continue;
    // A bare number is never one of our part numbers; it's typically a
    // count or total at the foot of the sheet.
    if (/^\d+$/.test(serial)) { numericParts.push(serial); continue; }
    if (seen.has(serial)) { duplicates.push(serial); continue; }
    seen.add(serial);

    const row: ImportRow = { serial_number: serial };
    const cellFor = (column: string) => {
      const at = [...columnAt].find(([, c]) => c === column)?.[0];
      return at === undefined ? '' : cellText(raw[at]);
    };
    for (const g of fullGroups) {
      const slots = [1, 2, 3, 4, 5].map((i) => cellFor(`${g}_${i}`));
      if (slots.some((s) => s !== '')) slots.forEach((s, i) => { row[`${g}_${i + 1}`] = s; });
    }
    for (const [i, column] of columnAt) {
      if (column === 'serial_number' || inFullGroup(column)) continue;
      const text = cellText(raw[i]);
      if (text === '') continue;
      if (INTEGER_COLUMNS.has(column) || NUMBER_COLUMNS.has(column)) {
        const n = Number(text.replace(/\s/g, ''));
        if (!Number.isFinite(n) || (INTEGER_COLUMNS.has(column) && !Number.isInteger(n))) {
          badCells.push(`${serial} ${column} "${text}"`);
          continue;
        }
        row[column] = n;
      } else if (column === 'status') {
        const s = text.toUpperCase();
        if (!STATUSES.includes(s)) { badCells.push(`${serial} status "${text}"`); continue; }
        row[column] = s;
      } else if (column === 'color') {
        row[column] = text.slice(0, 50);
      } else {
        row[column] = text;
      }
    }
    rows.push(row);
  }

  const notes: string[] = [];
  if (duplicates.length) notes.push(`Skipped ${duplicates.length} repeated part number${duplicates.length === 1 ? '' : 's'} (the first row for each is used): ${[...new Set(duplicates)].join(', ')}.`);
  if (numericParts.length) notes.push(`Skipped ${numericParts.length} row${numericParts.length === 1 ? '' : 's'} whose part number is just a number (${numericParts.join(', ')}), likely a total.`);
  if (badCells.length) notes.push(`Left ${badCells.length} cell${badCells.length === 1 ? '' : 's'} unchanged because the value doesn't fit the column: ${badCells.slice(0, 8).join('; ')}${badCells.length > 8 ? '…' : ''}.`);
  return { sheetName, columns, ignoredHeaders, rows, notes };
}

/** Picks the first sheet of a workbook that reads as an inventory list. */
export function planFromSheets(sheets: Array<{ name: string; rows: unknown[][] }>): ImportPlan | { error: string } {
  for (const sheet of sheets) {
    const plan = planFromTable(sheet.rows, sheet.name);
    if ('error' in plan) continue;
    if (sheet !== sheets[0]) {
      plan.notes.unshift(`Read the sheet "${sheet.name}". The first sheet, "${sheets[0].name}", is not an inventory list.`);
    }
    return plan;
  }
  return { error: 'No sheet in this workbook is an inventory list. Its first row needs column names, including a part number column (serial_number or SerialNumber).' };
}

/** The batch as a ';' CSV, kept as a record of exactly what was applied. */
export function planToCsv(plan: ImportPlan): string {
  const header = ['serial_number', ...plan.columns];
  const cell = (v: ImportValue | undefined) => {
    const s = v == null ? '' : String(v);
    return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header.join(';'), ...plan.rows.map((r) => header.map((h) => cell(r[h])).join(';'))].join('\n') + '\n';
}
