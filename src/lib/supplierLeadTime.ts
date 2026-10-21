// Supplier lead times, measured: for each received purchase order, the days
// from its order date to when it was marked Received (purchase_orders.
// received_at, kept from 2026-10-21). A bill's date is not used: bills are
// often entered when the order is placed, which would read as 0 days. The
// measured figure is the median over the supplier's orders. Where a supplier
// has none yet, the lead time typed on the supplier is used. Restock
// suggestions use it per item: its Supplier field's supplier, else the
// slowest of the suppliers it has part numbers for (phase5-routes).

const DAY = 86_400_000;

export interface LeadTimeOrder { supplierId: string; orderDate: string | Date | null; receivedDate: string | Date | null }
export interface MeasuredLeadTime { days: number; orders: number; slowest: number }

const time = (d: string | Date | null) => (d == null ? NaN : new Date(d).getTime());

/** The median days from order to receipt per supplier, over its received orders. */
export function measureLeadTimes(orders: LeadTimeOrder[]): Map<string, MeasuredLeadTime> {
  const by = new Map<string, number[]>();
  for (const o of orders) {
    const ordered = time(o.orderDate); const received = time(o.receivedDate);
    if (!o.supplierId || !Number.isFinite(ordered) || !Number.isFinite(received)) continue;
    const days = Math.max(0, Math.round((received - ordered) / DAY));
    by.set(String(o.supplierId), [...(by.get(String(o.supplierId)) ?? []), days]);
  }
  const out = new Map<string, MeasuredLeadTime>();
  for (const [id, list] of by) {
    const s = [...list].sort((a, b) => a - b);
    const mid = s.length >> 1;
    const median = s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
    out.set(id, { days: median, orders: s.length, slowest: s[s.length - 1] });
  }
  return out;
}

export interface SupplierLead { id: string; name: string; lead_time?: number | null }

/** The lead time to plan with: measured, else typed on the supplier, else null. */
export function plannedLeadTime(s: SupplierLead | undefined, measured: Map<string, MeasuredLeadTime>): { days: number; source: 'measured' | 'typed' } | null {
  if (!s) return null;
  const m = measured.get(String(s.id));
  if (m) return { days: m.days, source: 'measured' };
  const typed = Number(s.lead_time);
  return s.lead_time != null && Number.isFinite(typed) && typed > 0 ? { days: typed, source: 'typed' } : null;
}

const key = (v: unknown) => String(v ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

/** A supplier by name however it is written ("Digikey", "LCSC" for LCSC ELECTRONICS, "MICRO ROBOTICS"), or by id. */
export function findSupplier<T extends SupplierLead>(name: unknown, suppliers: T[]): T | undefined {
  const raw = String(name ?? '').trim();
  const k = key(raw);
  if (!k) return undefined;
  return suppliers.find((x) => String(x.id) === raw) ?? suppliers.find((x) => key(x.name) === k)
    ?? suppliers.find((x) => { const n = key(x.name); return n.length >= 4 && k.length >= 4 && (n.startsWith(k) || k.startsWith(n)); });
}

/** An item's lead time by its Supplier field ("Digikey", "LCSC ELECTRONICS", ...), or null. */
export function leadTimeForSupplierName(name: unknown, suppliers: SupplierLead[], measured: Map<string, MeasuredLeadTime>) {
  const s = findSupplier(name, suppliers);
  const planned = plannedLeadTime(s, measured);
  return s && planned ? { supplier: s.name, ...planned } : null;
}

/** SQL: the received purchase orders, with the date each was received. */
export const RECEIVED_ORDERS_SQL = `
  SELECT po.supplier_id, po.order_date, po.received_at AS received_date
    FROM purchase_orders po
   WHERE po.status = 'RECEIVED' AND po.received_at IS NOT NULL`;

/** The supplier names that sell each part-number slot (1 Mouser, 2 DigiKey, 3 LCSC). */
export const SLOT_SUPPLIER_NAMES = ['MOUSER', 'DIGIKEY', 'LCSC'];

/** For an item with no Supplier field: the slowest lead time of the suppliers it has part numbers for. */
export function slowestSlotLeadTime(supPns: unknown[], suppliers: SupplierLead[], measured: Map<string, MeasuredLeadTime>) {
  let best: { supplier: string; days: number; source: 'measured' | 'typed' } | null = null;
  SLOT_SUPPLIER_NAMES.forEach((name, i) => {
    const v = String(supPns[i] ?? '').trim();
    if (!v || /^(N\/?A|-|NONE)$/i.test(v)) return;
    const l = leadTimeForSupplierName(name, suppliers, measured);
    if (l && (!best || l.days > best.days)) best = l;
  });
  return best as { supplier: string; days: number; source: 'measured' | 'typed' } | null;
}
