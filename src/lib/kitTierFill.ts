// Kit Booking's "auto-fill by tier": cover a line's requirement from its
// match candidates in tier order (the match service sorts T1 exact first),
// taking from each what is free after other kits' reservations. Only T1
// (exact) and T2 (same value and footprint) are used: a footprint swap (T3)
// or a fuzzy match (T4) is the operator's call. Shared by Auto-allocate,
// the allocation dialog's Auto-fill by tier, and its first preselection, in
// P&P Kit Booking and the Bill of Materials.
//
// A reel already listed can't be suggested again: another line's own part on
// the same BOM is never an alternate (that line needs it), and what other
// lines have already picked from a reel counts as used (allocateAllByTier).

export interface TierCandidate { serialNumber: string; stock: number; matchTier: number }
export type Picks = Array<{ allocatedCode: string; qty: number }>;

export function fillByTier(
  candidates: TierCandidate[],
  needed: number,
  reservations: Record<string, number>,
  opts: { exclude?: Set<string> } = {},
): { picks: Picks; remaining: number } {
  const picks: Picks = [];
  let remaining = Math.max(0, needed);
  const ordered = [...candidates].sort((a, b) => a.matchTier - b.matchTier);
  for (const c of ordered) {
    if (remaining <= 0) break;
    if (c.matchTier > 2) continue;
    if (opts.exclude?.has(c.serialNumber.toUpperCase())) continue;
    const free = Math.max(0, (Number(c.stock) || 0) - (reservations[c.serialNumber] || 0));
    const take = Math.min(free, remaining);
    if (take > 0) { picks.push({ allocatedCode: c.serialNumber, qty: take }); remaining -= take; }
  }
  return { picks, remaining };
}

/** Other lines' own parts on this BOM: never an alternate for this line. */
export function otherLinesParts(lineCodes: string[], self: string): Set<string> {
  const me = self.toUpperCase();
  return new Set(lineCodes.map((c) => c.toUpperCase()).filter((c) => c !== me));
}

/** What other lines have picked from each reel, added to the reservations. */
export function withPickedElsewhere(reservations: Record<string, number>, allocations: Record<string, Picks | undefined>, self: string): Record<string, number> {
  const out = { ...reservations };
  for (const [line, picks] of Object.entries(allocations)) {
    if (line === self) continue;
    for (const p of picks ?? []) out[p.allocatedCode] = (out[p.allocatedCode] || 0) + (Number(p.qty) || 0);
  }
  return out;
}

/**
 * Auto-allocate for a whole BOM: each line in turn, by tier, never using
 * another line's own part, and counting what earlier lines took from a reel.
 * Lines that keep their picks (`keep`) are counted first.
 */
export function allocateAllByTier(
  lines: Array<{ code: string; needed: number }>,
  matches: Record<string, TierCandidate[]>,
  reservations: Record<string, number>,
  keep: Record<string, Picks> = {},
): { allocations: Record<string, Picks>; filled: number; short: number; none: string[] } {
  const codes = lines.map((l) => l.code);
  const used: Record<string, number> = { ...reservations };
  for (const picks of Object.values(keep)) for (const p of picks) used[p.allocatedCode] = (used[p.allocatedCode] || 0) + p.qty;
  const allocations: Record<string, Picks> = {};
  const none: string[] = [];
  let filled = 0, short = 0;
  for (const l of lines) {
    if (keep[l.code]) continue;
    const { picks, remaining } = fillByTier(matches[l.code] || [], l.needed, used, { exclude: otherLinesParts(codes, l.code) });
    if (!picks.length) { none.push(l.code); continue; }
    allocations[l.code] = picks;
    for (const p of picks) used[p.allocatedCode] = (used[p.allocatedCode] || 0) + p.qty;
    filled++;
    if (remaining > 0) short++;
  }
  return { allocations, filled, short, none };
}
