// What a kit book-out takes from stock (POST /api/kit-booking/execute).
// Each BOM line takes the reels picked for it (Kit Booking and the BOM
// audit let a line be split over several SKUs) or, with no picks, its
// resolved part for the whole requirement; DNF lines take nothing. It is
// refused, as a whole, when a line isn't covered or a SKU hasn't the stock
// for everything asked of it across all lines.

export interface BookOutLine { component_id: string; resolved_part_number: string; qty_required: number; /** The audit's shortage (after other kits' reservations), for a line with no picks. */ shortage_qty?: number }
export interface Pick { allocatedCode: string; qty: number }
export interface Deduction { code: string; qty: number; forLine: string }

export function planKitBookOut(
  lines: BookOutLine[],
  allocations: Record<string, Pick[] | undefined>,
  dnf: string[],
  stock: Map<string, { stock: number }>,
): { deductions: Deduction[]; skipped: string[]; problems: string[] } {
  const deductions: Deduction[] = [];
  const skipped: string[] = [];
  const problems: string[] = [];
  const dnfSet = new Set(dnf);
  for (const l of lines) {
    if (dnfSet.has(l.component_id) || !(l.qty_required > 0)) { skipped.push(l.component_id); continue; }
    const picks = (allocations[l.component_id] ?? []).filter((p) => p && Number(p.qty) > 0);
    if (picks.length) {
      for (const p of picks) {
        const qty = Number(p.qty);
        if (!Number.isFinite(qty) || qty !== Math.floor(qty)) { problems.push(`${l.component_id}: ${p.allocatedCode} has a quantity that isn't a whole number.`); continue; }
        if (!stock.has(String(p.allocatedCode))) { problems.push(`${l.component_id}: ${p.allocatedCode} isn't in Items & Inventory.`); continue; }
        deductions.push({ code: String(p.allocatedCode), qty, forLine: l.component_id });
      }
      const covered = picks.reduce((s, p) => s + (Number(p.qty) || 0), 0);
      if (covered < l.qty_required) problems.push(`${l.component_id}: picks cover ${covered} of ${l.qty_required}.`);
    } else {
      // As before: the audit's shortage counts stock other kits have reserved.
      if ((l.shortage_qty ?? 0) > 0) problems.push(`${l.component_id}: short by ${l.shortage_qty}.`);
      deductions.push({ code: l.resolved_part_number, qty: l.qty_required, forLine: l.component_id });
    }
  }
  // Every SKU must have the stock for everything taken from it.
  const totals = new Map<string, number>();
  for (const d of deductions) totals.set(d.code, (totals.get(d.code) ?? 0) + d.qty);
  for (const [code, qty] of totals) {
    const have = stock.get(code)?.stock;
    if (have === undefined) { if (!problems.some((p) => p.includes(code))) problems.push(`${code} isn't in Items & Inventory.`); continue; }
    if (have < qty) problems.push(`${code}: needs ${qty}, has ${have}.`);
  }
  return { deductions, skipped, problems };
}
