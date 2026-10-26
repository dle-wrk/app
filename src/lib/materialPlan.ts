// Material planning (MRP), the rules. Demand: open sales orders (a product's
// lines broken down through what it is made of: its boards' BOMs), planned
// production jobs, and optionally quotes and saved kits; each with the date
// it is needed. Supply: stock on hand, and open purchase-order lines by the
// date they are due. Per part, in date order, the running balance shows the
// first date it runs short; the shortfall is what to buy, and the order-by
// date is that date less the supplier's lead time. DNF lines are never
// demand (./dnf). Routes: ./materialPlanningRoutes.

import { isDnfCode } from './dnf';

export interface Demand { partNumber: string; qty: number; needBy: string | null; source: string }
export interface Receipt { partNumber: string; qty: number; due: string | null; source: string }
export interface PartInfo { name: string; stock: number; safety: number; leadDays: number | null; leadNote: string; supplier: string | null }

export interface PlanRow {
  partNumber: string; name: string; stock: number; demand: number; onOrder: number; safety: number;
  shortBy: string | null;      // first date the balance goes below the safety level
  shortfall: number;           // what to buy to cover every demand (and the safety level)
  orderBy: string | null;      // shortBy less the lead time
  late: boolean;               // orderBy is before today
  leadDays: number | null; leadNote: string; supplier: string | null;
  demands: Demand[]; receipts: Receipt[];
}

const DAY = 86_400_000;
const day = (d: string | null) => (d ? d.slice(0, 10) : null);

/** Lines a product needs per unit, through its boards: [{project, perUnit}] × each board's BOM lines. */
export function explode(qty: number, boards: Array<{ perUnit: number; lines: Array<{ code: string; qtyPerBoard: number }> }>): Array<{ code: string; qty: number }> {
  const out = new Map<string, number>();
  for (const b of boards) for (const l of b.lines) {
    if (!l.code || isDnfCode(l.code)) continue;
    out.set(l.code, (out.get(l.code) ?? 0) + qty * b.perUnit * l.qtyPerBoard);
  }
  return [...out].map(([code, q]) => ({ code, qty: q }));
}

export function planParts(demands: Demand[], receipts: Receipt[], parts: Map<string, PartInfo>, today = new Date()): PlanRow[] {
  const codes = new Set(demands.filter((d) => d.qty > 0 && !isDnfCode(d.partNumber)).map((d) => d.partNumber));
  const todayStr = today.toISOString().slice(0, 10);
  const rows: PlanRow[] = [];
  for (const code of codes) {
    const info = parts.get(code) ?? { name: '', stock: 0, safety: 0, leadDays: null, leadNote: 'not in inventory', supplier: null };
    const ds = demands.filter((d) => d.partNumber === code && d.qty > 0).sort((a, b) => (day(a.needBy) ?? todayStr).localeCompare(day(b.needBy) ?? todayStr));
    const rs = receipts.filter((r) => r.partNumber === code && r.qty > 0).sort((a, b) => (day(a.due) ?? '9999').localeCompare(day(b.due) ?? '9999'));
    // Walk the dates: receipts due on or before a demand's date count for it.
    let balance = info.stock; let shortBy: string | null = null; let ri = 0;
    for (const d of ds) {
      const when = day(d.needBy) ?? todayStr;
      while (ri < rs.length && (day(rs[ri].due) ?? '9999') <= when) balance += rs[ri++].qty;
      balance -= d.qty;
      if (shortBy === null && balance < info.safety) shortBy = when < todayStr ? todayStr : when;
    }
    const demand = ds.reduce((s, d) => s + d.qty, 0);
    const onOrder = rs.reduce((s, r) => s + r.qty, 0);
    const shortfall = Math.max(0, Math.ceil(demand + info.safety - info.stock - onOrder));
    if (shortfall === 0) shortBy = null; // a receipt that is merely late still covers it: flagged by the late receipt, not as a buy
    const orderBy = shortBy && info.leadDays !== null ? new Date(new Date(shortBy).getTime() - info.leadDays * DAY).toISOString().slice(0, 10) : shortBy;
    rows.push({
      partNumber: code, name: info.name, stock: info.stock, demand, onOrder, safety: info.safety, shortBy, shortfall, orderBy,
      late: !!orderBy && orderBy < todayStr, leadDays: info.leadDays, leadNote: info.leadNote, supplier: info.supplier, demands: ds, receipts: rs,
    });
  }
  // What to buy first, soonest first; covered parts last.
  return rows.sort((a, b) => (b.shortfall > 0 ? 1 : 0) - (a.shortfall > 0 ? 1 : 0) || (a.orderBy ?? '9999').localeCompare(b.orderBy ?? '9999') || a.partNumber.localeCompare(b.partNumber));
}
