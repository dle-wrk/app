// Order files as one workbook (BOM Audit and restock): Summary, then a sheet
// per supplier (its upload columns first, as in its CSV, then the stock
// codes, description and prices once checked), "All lines" (each line with
// what it would cost at each supplier and where it goes), and "Not listed"
// (lines no supplier of the three has a number for). Builds on the same
// orders the CSV buttons write, so the two always agree.

import type { SlotSupplier } from './partNumbers';
import { ORDER_SUPPLIERS, plainText, supplierNumberFor, type SupplierOrder } from './supplierBom';
import { isPriced, type LineQuotes } from './supplierQuotes';
import type { Sheet } from './kitShortageWorkbook';

export interface WorkbookLine { stockCode: string; description: string; footprint: string; supPns?: Array<string | null | undefined>; qty: number }

export function buildOrderSheets(input: {
  title: string;                       // e.g. "TCU06 PCB: shortages for 50 pcs"
  date: string;
  lines: WorkbookLine[];
  orders: SupplierOrder[];
  quotes?: Map<string, LineQuotes> | null;
  assignment?: Record<string, SlotSupplier | null> | null;  // the split, when one is used
}): Sheet[] {
  const { lines, orders, quotes, assignment } = input;
  const checked = !!quotes;
  const priceOf = (code: string, s: SlotSupplier) => {
    const p = quotes?.get(code)?.[s];
    return isPriced(p) ? p : null;
  };

  // Each supplier's order, with what each row costs once checked.
  const supplierSheets: Sheet[] = orders.map((o) => {
    const extra = ['Stock codes', 'Description', ...(checked ? ['Unit price (R)', 'Total (R)'] : [])];
    const upload = o.supplier === 'mouser' ? ['Mouser Part Number', 'Quantity'] : o.supplier === 'digikey' ? ['Quantity', 'Part Number'] : ['Comment', 'Designator', 'Footprint', 'LCSC Part #', 'Quantity'];
    const rows: Array<Array<string | number>> = [[...upload, ...extra]];
    let total = 0;
    for (const r of o.rows) {
      const codes = r.stockCodes ?? [];
      const priced = codes.map((c) => priceOf(c, o.supplier)).find(Boolean) ?? null;
      const unit = priced ? Math.round(priced.unitZar * 10000) / 10000 : null;
      const lineTotal = priced ? Math.round(priced.unitZar * r.qty * 100) / 100 : null;
      if (lineTotal) total += lineTotal;
      const head = o.supplier === 'mouser' ? [r.supplierPn, r.qty] : o.supplier === 'digikey' ? [r.qty, r.supplierPn]
        : [plainText(r.description).replace(/,/g, ' '), '', plainText(r.footprint), r.supplierPn, r.qty];
      rows.push([...head, codes.join(', '), r.description, ...(checked ? [unit ?? '', lineTotal ?? ''] : [])]);
    }
    if (!o.rows.length) rows.push([assignment ? `No line is cheapest at ${o.label}.` : `No line has a ${o.label} part number.`]);
    else if (checked) rows.push([], ['Total (R)', '', ...Array(upload.length - 2 + extra.length - 1).fill(''), Math.round(total * 100) / 100]);
    const widths = o.supplier === 'lcsc' ? [40, 12, 14, 14, 10, 18, 40, 14, 12] : [26, 10, 18, 40, 14, 12];
    return { name: o.label, rows, widths };
  });

  // Every line, what it would cost at each supplier, and where it goes.
  const all: Sheet = {
    name: 'All lines',
    rows: [['Stock code', 'Description', 'Footprint', 'Qty needed', ...ORDER_SUPPLIERS.flatMap(({ label }) => [`${label} PN`, ...(checked ? [`${label} buy`, `${label} total (R)`] : [])]), ...(assignment ? ['Order from'] : [])]],
    widths: [16, 40, 14, 11, ...ORDER_SUPPLIERS.flatMap(() => (checked ? [22, 10, 14] : [22])), ...(assignment ? [12] : [])],
  };
  for (const l of lines) {
    const cells: Array<string | number> = [l.stockCode, l.description, l.footprint, l.qty];
    for (const { key } of ORDER_SUPPLIERS) {
      const p = priceOf(l.stockCode, key);
      cells.push(p?.supplierPn || supplierNumberFor(l.supPns, key) || '');
      if (checked) cells.push(p ? p.orderQty : '', p ? p.totalZar : '');
    }
    if (assignment) cells.push(ORDER_SUPPLIERS.find((s) => s.key === assignment[l.stockCode])?.label ?? '');
    all.rows.push(cells);
  }

  const notListed = lines.filter((l) => ORDER_SUPPLIERS.every(({ key }) => !supplierNumberFor(l.supPns, key)));
  const missing: Sheet = { name: 'Not listed', rows: [['Stock code', 'Description', 'Footprint', 'Qty needed']], widths: [16, 40, 14, 11] };
  for (const l of notListed) missing.rows.push([l.stockCode, l.description, l.footprint, l.qty]);
  if (!notListed.length) missing.rows.push(['Every line has a Mouser, DigiKey or LCSC part number.']);

  const summary: Sheet = {
    name: 'Summary',
    rows: [
      [input.title], [`Made ${input.date}`],
      [checked ? 'Quantities checked with the suppliers: their minimums, pack steps and packaging.' : 'Quantities not checked with the suppliers (Compare prices first to round them to what each one sells).'],
      [assignment ? 'Each line goes to its cheapest supplier (or the one chosen).' : 'Each supplier sheet has every line that supplier lists.'],
      [],
      ['Supplier', 'Lines', ...(checked ? ['Total (R)'] : []), 'Not listed there'],
      ...orders.map((o) => {
        const total = o.rows.reduce((s, r) => {
          const p = (r.stockCodes ?? []).map((c) => priceOf(c, o.supplier)).find(Boolean);
          return s + (p ? p.unitZar * r.qty : 0);
        }, 0);
        return [o.label, o.rows.length, ...(checked ? [Math.round(total * 100) / 100] : []), assignment ? '' : o.missing.length];
      }),
      [],
      ['Lines with no Mouser, DigiKey or LCSC number', notListed.length],
    ],
    widths: [44, 10, 14, 16],
  };
  return [summary, ...supplierSheets, all, missing];
}
