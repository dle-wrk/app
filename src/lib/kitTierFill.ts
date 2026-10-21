// Kit Booking's "auto-fill by tier": cover a line's requirement from its
// match candidates in tier order (the match service sorts T1 exact first),
// taking from each what is free after other kits' reservations. Only T1
// (exact) and T2 (same value and footprint) are used: a footprint swap (T3)
// or a fuzzy match (T4) is the operator's call. Shared by Auto-allocate,
// the allocation dialog's Auto-fill by tier, and its first preselection.

export interface TierCandidate { serialNumber: string; stock: number; matchTier: number }

export function fillByTier(
  candidates: TierCandidate[],
  needed: number,
  reservations: Record<string, number>,
): { picks: Array<{ allocatedCode: string; qty: number }>; remaining: number } {
  const picks: Array<{ allocatedCode: string; qty: number }> = [];
  let remaining = Math.max(0, needed);
  const ordered = [...candidates].sort((a, b) => a.matchTier - b.matchTier);
  for (const c of ordered) {
    if (remaining <= 0) break;
    if (c.matchTier > 2) continue;
    const free = Math.max(0, (Number(c.stock) || 0) - (reservations[c.serialNumber] || 0));
    const take = Math.min(free, remaining);
    if (take > 0) { picks.push({ allocatedCode: c.serialNumber, qty: take }); remaining -= take; }
  }
  return { picks, remaining };
}
