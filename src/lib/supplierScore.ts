// A supplier's score from what actually happened: its purchase orders
// (received, and on time where an expected date and a receipt date are both
// known) and the non-conformance reports raised against it. Too few received
// orders give no score rather than a made-up one.

export interface SupplierRecord {
  orders: number;
  received: number;
  /** Received orders with both an expected date and a receipt date. */
  timed: number;
  onTime: number;
  ncrs: number;
  /** Median days from order to receipt, if measured. */
  leadDays?: number | null;
}

export interface SupplierScore { score: number | null; onTimePct: number | null; qualityScore: number | null; note: string }

export const MIN_RECEIVED = 3;
const round1 = (n: number) => Math.round(n * 10) / 10;

export function scoreSupplier(r: SupplierRecord): SupplierScore {
  const onTimePct = r.timed > 0 ? round1((r.onTime / r.timed) * 100) : null;
  const qualityScore = r.received > 0 ? round1(100 * (1 - Math.min(1, r.ncrs / r.received))) : null;
  const facts = [
    `${r.orders} order${r.orders === 1 ? '' : 's'}, ${r.received} received`,
    onTimePct !== null ? `${onTimePct}% on time (of ${r.timed} with dates)` : 'no on-time record (needs expected and received dates)',
    `${r.ncrs} NCR${r.ncrs === 1 ? '' : 's'}`,
    r.leadDays ? `lead time ${r.leadDays} days` : null,
  ].filter(Boolean).join('; ');
  if (r.received < MIN_RECEIVED) return { score: null, onTimePct, qualityScore, note: `Not enough received orders to score (${r.received} of ${MIN_RECEIVED}). ${facts}.` };
  // On time counts for 60% where it is known; quality (orders without an NCR) the rest.
  const score = onTimePct !== null ? round1(0.6 * onTimePct + 0.4 * (qualityScore ?? 100)) : (qualityScore ?? null);
  return { score, onTimePct, qualityScore, note: `${onTimePct !== null ? '60% on time, 40% quality' : 'Quality only'}: ${facts}.` };
}
