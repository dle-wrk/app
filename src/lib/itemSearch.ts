// Searching items: the one rule every item search box uses (Items &
// Inventory, Stock Tables, the BOM Manager, Link Components, line items,
// the command palette). Use itemMatches for any new item search too.
//
// An item matches when every word of the search is found in one of its
// fields: stock code, name, description, value, size, package, footprint,
// tolerance, type, comment, project, packaging, colour, supplier, and every
// manufacturer and supplier part number. "1206 100nF" finds the 100nF parts
// in 1206. Case doesn't matter.
//
// It used to look at the name, stock code and manufacturer only, so a
// search for a footprint found only the items with it in their name.

import type { Item } from '../types';

const NONE = new Set(['', 'N/A', 'NA', '-']);

/** The item's searchable text, one entry per field. */
export function searchFields(item: Partial<Item>): string[] {
  const fields = [
    item.partNumber, item.name, item.description, item.value, item.size, (item as any).sizeMetric, item.packageName, item.footprint,
    item.tolerance, item.itemType, item.category, item.comment, item.project, item.packaging, item.color, item.supplier, item.manufacturer,
    ...(item.manPns ?? []), ...(item.supPns ?? []),
  ];
  return fields.map((f) => String(f ?? '').trim()).filter((f) => !NONE.has(f.toUpperCase()));
}

export function searchWords(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** Whether an item matches a search (an empty search matches everything). */
export function itemMatches(item: Partial<Item>, query: string): boolean {
  const words = searchWords(query);
  if (!words.length) return true;
  const fields = searchFields(item).map((f) => f.toLowerCase());
  return words.every((w) => fields.some((f) => f.includes(w)));
}

// ---------------------------------------------------------------------------
// Footprints, for the footprint filter. An item's footprint is whatever its
// footprint, package and size fields say ("1206", "SOT-23", "0603 (1608
// metric)"); the filter lists the footprints in use and matches an item when
// any of the three holds that footprint as a whole word.
// ---------------------------------------------------------------------------

/** "SOT23" and "SOT-23" are the same footprint; so are "1206" and "C1206". */
export function footprintKey(text: string): string {
  // A bracketed alias doesn't make a different footprint: "DO-214AA (SMB)" is DO-214AA.
  return text.replace(/\([^)]*\)/g, ' ').trim().toUpperCase().replace(/[\s_]+/g, '-').replace(/-+$/, '').replace(/^([A-Z]{1,2})(\d{4})$/, '$2').replace(/^(SOT|SOD|SOIC|TSSOP|SSOP|QFN|QFP|LQFP|TQFP|DFN|TO|DO|SMA|SMB|SMC)-?(\d)/, '$1-$2');
}

/** The footprints an item is in: each footprint/package/size value, and the first word of it ("0603" of "0603 (1608 metric)"). */
export function itemFootprints(item: Partial<Item>): string[] {
  const keys = new Set<string>();
  for (const raw of [item.footprint, item.packageName, item.size]) {
    const text = String(raw ?? '').trim();
    if (NONE.has(text.toUpperCase())) continue;
    const key = footprintKey(text);
    if (key) keys.add(key);
    const first = text.split(/[\s(,/]+/)[0];
    if (first && first !== text) keys.add(footprintKey(first));
  }
  return [...keys];
}

/** Every footprint in use, with how many items are in it, most common first. */
export function footprintOptions(items: Partial<Item>[]): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) for (const key of itemFootprints(item)) counts.set(key, (counts.get(key) ?? 0) + 1);
  return [...counts].map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key, undefined, { numeric: true }));
}
