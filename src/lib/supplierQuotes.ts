// The cheapest supplier for each order line. A supplier's offer is its price
// ladder for its own part number (Sup PN 1 Mouser, 2 DigiKey, 3 LCSC) with
// its minimum and multiple; the price is what that ladder charges for the
// quantity actually bought (raised to the minimum / the next multiple), in
// rand at the daily rate. A supplier that can't cover the quantity from
// stock is only chosen when none can. Fetching: ./supplierQuoteRoutes.

import type { SlotSupplier } from './partNumbers';

export interface Ladder {
  supplierPn: string;
  currency: string;          // ISO: USD, ZAR, ...
  breaks: Array<{ qty: number; price: number }>; // unit price from each quantity, any order
  moq: number;               // minimum order quantity (>= 1)
  mult: number;              // order in multiples of this (>= 1)
  stock: number | null;      // null when the supplier doesn't say
  url?: string | null;
  /** e.g. "Tape & Reel (TR)", "Cut Tape (CT)". */
  packaging?: string | null;
  /** The same part in other packagings (DigiKey): quoting may pick one. */
  alternatives?: Ladder[];
}

export interface Priced {
  supplierPn: string;
  orderQty: number;          // what would be bought: >= the quantity needed
  unit: number;              // native currency
  currency: string;
  unitZar: number;
  totalZar: number;
  stock: number | null;
  enoughStock: boolean;
  /** Why more than needed would be bought, when it is. */
  note: string | null;
  /** The part number asked for, when another packaging of it was cheaper or could be bought at this quantity. */
  swappedFrom?: string | null;
  packaging?: string | null;
}

/** What a ladder charges for a quantity; null without prices. */
export function priceLadder(l: Ladder, qty: number, rateToZar: number): Priced | null {
  const breaks = l.breaks.filter((b) => b.qty > 0 && b.price > 0).sort((a, b) => a.qty - b.qty);
  if (!breaks.length || !(qty > 0) || !(rateToZar > 0)) return null;
  const moq = Math.max(1, l.moq || 1, breaks[0].qty);
  const mult = Math.max(1, l.mult || 1);
  let orderQty = Math.max(qty, moq);
  if (orderQty % mult) orderQty += mult - (orderQty % mult);
  const unit = [...breaks].reverse().find((b) => b.qty <= orderQty)?.price ?? breaks[0].price;
  const unitZar = unit * rateToZar;
  const enoughStock = l.stock === null || l.stock >= orderQty;
  const note = orderQty > qty ? (orderQty === moq ? `Minimum order ${moq}` : `Sold in multiples of ${mult}`) : null;
  return {
    supplierPn: l.supplierPn, orderQty, unit, currency: l.currency, unitZar,
    totalZar: Math.round(unitZar * orderQty * 100) / 100, stock: l.stock, enoughStock, note,
  };
}

/**
 * The best way to buy a quantity from a ladder that may have other
 * packagings of the same part: in stock first, then the lowest total. A
 * DigiKey reel number asked for 389 pieces comes back as its cut tape.
 */
export function bestPackaging(l: Ladder, qty: number, rateToZar: number): Priced | null {
  const options: Priced[] = [];
  for (const x of [l, ...(l.alternatives ?? [])]) {
    const p = priceLadder(x, qty, rateToZar);
    if (p) options.push({ ...p, packaging: x.packaging ?? null });
  }
  if (!options.length) return null;
  const pool = options.some((p) => p.enoughStock) ? options.filter((p) => p.enoughStock) : options;
  const best = pool.reduce((a, b) => (b.totalZar < a.totalZar || (b.totalZar === a.totalZar && b.supplierPn === l.supplierPn) ? b : a));
  return best.supplierPn === l.supplierPn ? best : { ...best, swappedFrom: l.supplierPn };
}

export type LineQuotes = Partial<Record<SlotSupplier, Priced | { error: string }>>;

export const isPriced = (q: Priced | { error: string } | undefined): q is Priced => !!q && 'totalZar' in q;

/** The cheapest supplier for a line: in stock first, then by total cost. */
export function cheapestSupplier(quotes: LineQuotes): SlotSupplier | null {
  const priced = (Object.entries(quotes) as Array<[SlotSupplier, Priced | { error: string }]>).filter(([, q]) => isPriced(q)) as Array<[SlotSupplier, Priced]>;
  if (!priced.length) return null;
  const pool = priced.some(([, q]) => q.enoughStock) ? priced.filter(([, q]) => q.enoughStock) : priced;
  return pool.reduce((best, cur) => (cur[1].totalZar < best[1].totalZar ? cur : best))[0];
}

/** Totals for a split: each line at its chosen supplier, and what the dearest choice per line would have cost. */
export function splitSummary(lines: Array<{ quotes: LineQuotes; choice: SlotSupplier | null }>) {
  const bySupplier: Partial<Record<SlotSupplier, { lines: number; totalZar: number }>> = {};
  let total = 0;
  let dearest = 0;
  let unpriced = 0;
  for (const l of lines) {
    const q = l.choice ? l.quotes[l.choice] : undefined;
    if (!l.choice || !isPriced(q)) { unpriced += 1; continue; }
    const s = (bySupplier[l.choice] ??= { lines: 0, totalZar: 0 });
    s.lines += 1;
    s.totalZar = Math.round((s.totalZar + q.totalZar) * 100) / 100;
    total += q.totalZar;
    const prices = Object.values(l.quotes).filter(isPriced).map((p) => p.totalZar);
    dearest += Math.max(...prices);
  }
  return { bySupplier, totalZar: Math.round(total * 100) / 100, dearestZar: Math.round(dearest * 100) / 100, unpriced };
}
