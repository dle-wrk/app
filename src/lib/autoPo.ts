// Auto-PO: items you choose to watch (auto_po_config, one row per item). When
// a watched item's stock is at or below its threshold, a check drafts a
// purchase order to bring it back up to its minimum level. Nothing is ordered
// on its own: the check runs when someone presses Check now (Automation >
// Auto-PO), shows what it would draft first, and writes DRAFT purchase orders
// (or SENT, when the item is set to auto-approve). An item that already has a
// purchase order open for it (draft, sent or part-received) is skipped.
//
// Supplier, in order: the one chosen on the item's Auto-PO setting; the
// item's Supplier field; else the fastest of the suppliers it has part
// numbers for (1 Mouser, 2 DigiKey, 3 LCSC; lead times per ./supplierLeadTime).
// Lines for the same supplier go on one purchase order.

import { findSupplier, leadTimeForSupplierName, type MeasuredLeadTime, type SupplierLead, SLOT_SUPPLIER_NAMES } from './supplierLeadTime';

export interface AutoPoConfigRow { component_id: string; min_stock_level: number; auto_po_threshold: number; preferred_supplier?: string | null; auto_approve?: boolean; enabled?: boolean }
export interface AutoPoItem { serial_number: string; name?: string | null; stock?: number | string | null; current_cost_dollar?: number | string | null; supplier?: string | null; sup_pn_1?: string | null; sup_pn_2?: string | null; sup_pn_3?: string | null }

export interface AutoPoLine { partNumber: string; name: string; stock: number; threshold: number; minLevel: number; quantity: number; unitPrice: number; autoApprove: boolean; supplierReason: string }
export interface AutoPoGroup { supplierId: string | null; supplierName: string | null; status: 'DRAFT' | 'SENT'; lines: AutoPoLine[] }
export interface AutoPoSkip { partNumber: string; reason: string }

const blank = (v: unknown) => /^(|N\/?A|-|NONE)$/i.test(String(v ?? '').trim());

/** The supplier for one item, and why. */
export function pickSupplier(cfg: AutoPoConfigRow, item: AutoPoItem, suppliers: SupplierLead[], measured: Map<string, MeasuredLeadTime>): { id: string | null; name: string | null; reason: string } {
  const byIdOrName = (v: string) => findSupplier(v, suppliers);
  if (!blank(cfg.preferred_supplier)) {
    const s = byIdOrName(String(cfg.preferred_supplier).trim());
    if (s) return { id: String(s.id), name: s.name, reason: 'chosen on its Auto-PO setting' };
  }
  if (!blank(item.supplier)) {
    const s = byIdOrName(String(item.supplier).trim());
    if (s) return { id: String(s.id), name: s.name, reason: 'its Supplier field' };
  }
  let best: { s: SupplierLead; days: number } | null = null;
  [item.sup_pn_1, item.sup_pn_2, item.sup_pn_3].forEach((pn, i) => {
    if (blank(pn)) return;
    const l = leadTimeForSupplierName(SLOT_SUPPLIER_NAMES[i], suppliers, measured);
    const s = l ? suppliers.find((x) => x.name === l.supplier) : undefined;
    if (s && l && (!best || l.days < best.days)) best = { s, days: l.days };
  });
  if (best) { const b = best as { s: SupplierLead; days: number }; return { id: String(b.s.id), name: b.s.name, reason: `fastest of its suppliers (${b.days} days)` }; }
  return { id: null, name: null, reason: 'no supplier known: choose one on the PO' };
}

/** What a check would draft: one purchase order per supplier, and what it skipped and why. */
export function planAutoPos(configs: AutoPoConfigRow[], items: AutoPoItem[], openParts: Set<string>, suppliers: SupplierLead[], measured: Map<string, MeasuredLeadTime>): { groups: AutoPoGroup[]; skipped: AutoPoSkip[] } {
  const byPart = new Map(items.map((i) => [i.serial_number, i]));
  const groups = new Map<string, AutoPoGroup>();
  const skipped: AutoPoSkip[] = [];
  for (const cfg of configs) {
    if (cfg.enabled === false) continue;
    const item = byPart.get(cfg.component_id);
    if (!item) { skipped.push({ partNumber: cfg.component_id, reason: 'Not in inventory (deleted?).' }); continue; }
    const stock = Number(item.stock) || 0;
    const threshold = Number(cfg.auto_po_threshold) || 0;
    const minLevel = Number(cfg.min_stock_level) || 0;
    if (stock > threshold) continue; // fine: nothing to say
    if (openParts.has(cfg.component_id)) { skipped.push({ partNumber: cfg.component_id, reason: 'A purchase order is already open for it.' }); continue; }
    const quantity = Math.max(1, Math.ceil(minLevel - stock));
    const sup = pickSupplier(cfg, item, suppliers, measured);
    const status: 'DRAFT' | 'SENT' = cfg.auto_approve ? 'SENT' : 'DRAFT';
    const key = `${sup.id ?? ''}|${status}`;
    const g = groups.get(key) ?? { supplierId: sup.id, supplierName: sup.name, status, lines: [] };
    g.lines.push({ partNumber: cfg.component_id, name: String(item.name ?? ''), stock, threshold, minLevel, quantity, unitPrice: Number(item.current_cost_dollar) || 0, autoApprove: !!cfg.auto_approve, supplierReason: sup.reason });
    groups.set(key, g);
  }
  return { groups: [...groups.values()], skipped };
}
