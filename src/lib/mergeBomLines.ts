// One line per stock code. A CAD export can list the same part twice in a
// BOM (grouped by a different comment or value text: TCU06 has CAP-024 as
// C47,C43,C44,C49,C50 x5 and C14,C15,… x11). Shown apart, each line was
// compared against the part's whole stock, so the shortage was hidden, and
// allocations made for one applied to both. Merged as P&P Kit Booking's audit
// does: quantities added, designators joined, first non-empty text kept.

export interface BomLineLike {
  id: string;
  stockCode: string;
  quantity: number;
  designator: string;
  description: string;
  comment: string;
  footprint: string;
}

export function mergeBomLines<T extends BomLineLike>(lines: T[]): Array<T & { mergedFrom: number }> {
  const byCode = new Map<string, T & { mergedFrom: number }>();
  const order: string[] = [];
  for (const l of lines) {
    const key = String(l.stockCode ?? '').trim().toUpperCase();
    const seen = byCode.get(key);
    if (!seen) {
      byCode.set(key, { ...l, mergedFrom: 1 });
      order.push(key);
      continue;
    }
    seen.quantity = (Number(seen.quantity) || 0) + (Number(l.quantity) || 0);
    if (l.designator) seen.designator = seen.designator ? `${seen.designator}, ${l.designator}` : l.designator;
    if (!seen.description && l.description) seen.description = l.description;
    if (!seen.comment && l.comment) seen.comment = l.comment;
    if (!seen.footprint && l.footprint) seen.footprint = l.footprint;
    seen.mergedFrom += 1;
  }
  return order.map((k) => byCode.get(k)!);
}
