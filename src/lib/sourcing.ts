// Which suppliers an item can be ordered from: the ones it has a part number
// for (Sup PN 1 Mouser, 2 DigiKey, 3 LCSC, or a number plainly theirs in
// another slot; see ./supplierBom). Backs the "Sourcing" filter on Items &
// Inventory, so what still needs a supplier is easy to find.

import type { SlotSupplier } from './partNumbers';
import { ORDER_SUPPLIERS, supplierNumberFor } from './supplierBom';

export const SOURCING_FILTERS = [
  { key: 'ALL', label: 'All items' },
  { key: 'ALL_THREE', label: 'At Mouser, DigiKey and LCSC' },
  { key: 'SOME_MISSING', label: 'Missing a supplier' },
  { key: 'MISSING_MOUSER', label: 'Missing Mouser' },
  { key: 'MISSING_DIGIKEY', label: 'Missing DigiKey' },
  { key: 'MISSING_LCSC', label: 'Missing LCSC' },
  { key: 'NONE', label: 'At none of the three' },
] as const;
export type SourcingFilter = typeof SOURCING_FILTERS[number]['key'];

/** The suppliers (of Mouser, DigiKey, LCSC) the item has a part number for. */
export function itemSuppliers(item: { supPns?: string[] }): SlotSupplier[] {
  return ORDER_SUPPLIERS.filter(({ key }) => !!supplierNumberFor(item.supPns, key)).map(({ key }) => key);
}

export function matchesSourcing(item: { supPns?: string[] }, filter: SourcingFilter | string): boolean {
  if (filter === 'ALL') return true;
  const at = itemSuppliers(item);
  switch (filter) {
    case 'ALL_THREE': return at.length === 3;
    case 'SOME_MISSING': return at.length < 3;
    case 'MISSING_MOUSER': return !at.includes('mouser');
    case 'MISSING_DIGIKEY': return !at.includes('digikey');
    case 'MISSING_LCSC': return !at.includes('lcsc');
    case 'NONE': return at.length === 0;
    default: return true;
  }
}

/** How many items each filter would show. */
export function sourcingCounts(items: Array<{ supPns?: string[] }>): Record<SourcingFilter, number> {
  const out = Object.fromEntries(SOURCING_FILTERS.map((f) => [f.key, 0])) as Record<SourcingFilter, number>;
  for (const item of items) for (const f of SOURCING_FILTERS) if (matchesSourcing(item, f.key)) out[f.key] += 1;
  return out;
}
