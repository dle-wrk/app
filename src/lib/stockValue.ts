// What the stock is worth (Stock Tables' value cards). Items marked INACTIVE
// or DO NOT USE are set aside: still on the shelf, but not stock the
// business plans to use or sell, so they are left out of the main totals
// and valued on their own. DISCONTINUED and BOOKED OUT items are not
// current assets and count nowhere. Only positive stock counts (negative
// stock is an over-issue, a data fault).

import type { Item } from '../types';

export const SET_ASIDE_STATUSES = ['INACTIVE', 'DO NOT USE'];
const NOT_ASSETS = ['DISCONTINUED', 'BOOKED OUT'];

export interface StockValue {
  /** At cost, in dollars (item.price is the dollar cost). */
  costUsd: number;
  /** At the bulk price, in rand. */
  bulkZar: number;
  /** Items with stock in this group, and how many of those have a bulk price. */
  stocked: number;
  bulkPriced: number;
}

const empty = (): StockValue => ({ costUsd: 0, bulkZar: 0, stocked: 0, bulkPriced: 0 });

export function stockValues(items: Pick<Item, 'status' | 'price' | 'stockLevel' | 'bulkPriceZar'>[]): { counted: StockValue; setAside: StockValue } {
  const counted = empty();
  const setAside = empty();
  for (const item of items) {
    const qty = item.stockLevel || 0;
    const status = String(item.status ?? '').toUpperCase();
    if (qty <= 0 || NOT_ASSETS.includes(status)) continue;
    const group = SET_ASIDE_STATUSES.includes(status) ? setAside : counted;
    group.costUsd += (item.price || 0) * qty;
    group.bulkZar += (item.bulkPriceZar || 0) * qty;
    group.stocked += 1;
    if ((item.bulkPriceZar || 0) > 0) group.bulkPriced += 1;
  }
  return { counted, setAside };
}
