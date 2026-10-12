// The Items & Inventory price filter: a minimum and/or maximum, in dollars
// or rand. Item prices are kept in dollars (current_cost_dollar); a rand
// range is compared at the same rate the cards use to show the rand price,
// so what the filter keeps matches what is on screen.

import { parseAmount } from './productImport';

export type PriceCurrency = 'USD' | 'ZAR';

export interface PriceRange {
  currency: PriceCurrency;
  /** As typed: "", "100", "1 250,50"… */
  min: string;
  max: string;
}

export const NO_PRICE_RANGE: PriceRange = { currency: 'USD', min: '', max: '' };

/** The range as numbers; an empty or unreadable bound is left open. */
export function readRange(range: PriceRange): { min: number | null; max: number | null } {
  const bound = (v: string) => (v.trim() ? parseAmount(v) : null);
  return { min: bound(range.min), max: bound(range.max) };
}

export function isPriceRangeSet(range: PriceRange): boolean {
  const { min, max } = readRange(range);
  return min !== null || max !== null;
}

/** Whether an item priced `priceUsd` falls in the range (ends included). */
export function inPriceRange(priceUsd: number | null | undefined, range: PriceRange, usdToZar: number): boolean {
  const { min, max } = readRange(range);
  if (min === null && max === null) return true;
  const usd = Number(priceUsd ?? 0) || 0;
  const price = range.currency === 'ZAR' ? Math.round(usd * usdToZar * 100) / 100 : usd;
  return (min === null || price >= min) && (max === null || price <= max);
}
