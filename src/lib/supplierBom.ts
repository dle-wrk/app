// Supplier order files: one file per supplier, in the shape that supplier's
// website takes for a BOM upload or cart paste (the same formats as the
// legacy Python tool, used by the Supplier BOM Generator and the project BOM).
// Each item's supplier part number comes from that supplier's slot
// (1 Mouser, 2 DigiKey, 3 LCSC), or failing that from any slot holding a
// number that is plainly theirs (C123456, …-ND, 581-…).

import { classifyPartNumberBySupplier, isUsablePartNumber, type SlotSupplier } from './partNumbers';

export const ORDER_SUPPLIERS: Array<{ key: SlotSupplier; label: string; slot: number }> = [
  { key: 'mouser', label: 'Mouser', slot: 0 },
  { key: 'digikey', label: 'DigiKey', slot: 1 },
  { key: 'lcsc', label: 'LCSC', slot: 2 },
];

export interface OrderRow { supplierPn: string; qty: number; description: string; footprint: string; stockCodes?: string[] }

/** Mouser: one "part number|quantity" per line (Mouser's BOM tool / cart paste). */
export function toMouserCsv(rows: OrderRow[]): string {
  return rows.map(r => `${r.supplierPn}|${r.qty}`).join('\n') + '\n';
}
/** DigiKey: a Quantity, Part Number CSV (DigiKey's BOM manager upload). */
export function toDigikeyCsv(rows: OrderRow[]): string {
  const head = 'Quantity,Part Number\n';
  const body = rows.map(r => `${r.qty},"${r.supplierPn.replace(/"/g, '""')}"`).join('\n');
  return head + body + '\n';
}
/** Plain text for an upload file: ± ° Ω µ and the like spelled out, anything else non-ASCII dropped. */
export function plainText(s: string): string {
  return (s || '')
    .replace(/±/g, '+/-').replace(/°/g, ' deg').replace(/[ΩΩ]/g, 'ohm').replace(/[µμ]/g, 'u')
    .replace(/×/g, 'x').replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, "'")
    .normalize('NFKD').replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();
}

/** LCSC: Comment, Designator, Footprint, LCSC Part #, Quantity (LCSC's BOM tool). */
export function toLcscCsv(rows: OrderRow[]): string {
  const head = 'Comment,Designator,Footprint,LCSC Part #,Quantity\n';
  const esc = (s: string) => plainText(s).replace(/,/g, ' ').replace(/"/g, "'");
  const body = rows.map(r => `"${esc(r.description)}","","${esc(r.footprint)}","${r.supplierPn}",${r.qty}`).join('\n');
  return head + body + '\n';
}

export const orderCsv = (supplier: SlotSupplier, rows: OrderRow[]) =>
  supplier === 'mouser' ? toMouserCsv(rows) : supplier === 'digikey' ? toDigikeyCsv(rows) : toLcscCsv(rows);

/** An item's part number at a supplier: its slot, else any slot plainly holding theirs; '' when none. */
export function supplierNumberFor(supPns: Array<string | null | undefined> | undefined, supplier: SlotSupplier): string {
  const slots = Array.from({ length: 5 }, (_, i) => String(supPns?.[i] ?? '').trim());
  const own = slots[ORDER_SUPPLIERS.find((s) => s.key === supplier)!.slot];
  const whose = (v: string) => classifyPartNumberBySupplier(v);
  if (isUsablePartNumber(own) && (whose(own) === supplier || whose(own) === null)) return own;
  return slots.find((v) => isUsablePartNumber(v) && whose(v) === supplier) ?? '';
}

export interface OrderLine { stockCode: string; description: string; footprint: string; supPns?: Array<string | null | undefined>; qty: number }

export interface SupplierOrder {
  supplier: SlotSupplier;
  label: string;
  rows: OrderRow[];
  /** Stock codes this supplier has no number for. */
  missing: string[];
}

/**
 * The order for each supplier from a list of lines (quantity already worked
 * out): the lines it has a number for, the same number added together once.
 * With `assign` (a split, e.g. the cheapest supplier per line), each line goes
 * only to the supplier it is assigned, and a line not assigned goes nowhere.
 */
export function supplierOrders(
  lines: OrderLine[],
  assign?: Record<string, SlotSupplier | null | undefined>,
  /** Checked with the supplier: the part number and quantity to order there instead (packaging, minimum, multiple). */
  checked?: (stockCode: string, supplier: SlotSupplier) => { supplierPn: string; qty: number } | null,
): SupplierOrder[] {
  const wanted = lines.filter((l) => l.qty > 0);
  return ORDER_SUPPLIERS.map(({ key, label }) => {
    const byPn = new Map<string, OrderRow>();
    const missing: string[] = [];
    for (const l of wanted) {
      if (assign && assign[l.stockCode] !== key) { missing.push(l.stockCode); continue; }
      const own = supplierNumberFor(l.supPns, key);
      if (!own) { missing.push(l.stockCode); continue; }
      const c = checked?.(l.stockCode, key);
      const pn = c?.supplierPn || own;
      const qty = c?.qty ?? l.qty;
      const row = byPn.get(pn.toUpperCase());
      if (row) { row.qty += qty; row.stockCodes = [...(row.stockCodes ?? []), l.stockCode]; }
      else byPn.set(pn.toUpperCase(), { supplierPn: pn, qty, description: l.description, footprint: l.footprint, stockCodes: [l.stockCode] });
    }
    return { supplier: key, label, rows: [...byPn.values()], missing };
  });
}

/** Lines no supplier of the three has a number for. */
export const atNoSupplier = (orders: SupplierOrder[]) =>
  orders[0].missing.filter((code) => orders.every((o) => o.missing.includes(code)));

export function downloadCsv(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
