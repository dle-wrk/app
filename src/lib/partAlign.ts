// Lining up an item's three slot lists. Manufacturer part numbers, supplier
// part numbers and web links each have five slots, and slot n is the same
// supplier in all three: 1 Mouser, 2 DigiKey, 3 LCSC, 4-5 other. So Mfr PN 2
// is the manufacturer part number as DigiKey lists it, Sup PN 2 DigiKey's
// own number, Web Link 2 the DigiKey page. A slot with nothing for its
// supplier says N/A.
//
// alignItem works out the lined-up slots from what the item has and what
// the suppliers said (found by partAlignRoutes). It never drops a value: a
// manufacturer part number no supplier gave, a second link of one supplier
// or a link to another site goes to slot 4-5, and when 4-5 are full that
// list is left as it is.

import { classifyPartNumberBySupplier, type SlotSupplier } from './partNumbers';

export const SLOT_SUPPLIERS: SlotSupplier[] = ['mouser', 'digikey', 'lcsc'];
export const NA = 'N/A';
const NONE = new Set(['', 'N/A', 'NA', '-', 'GENERIC']);
const isNone = (v: unknown) => NONE.has(String(v ?? '').trim().toUpperCase());
const same = (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase();

/** Whose page a link is: by its address. */
export function linkSupplier(url: string): SlotSupplier | 'other' | null {
  const u = String(url ?? '').trim();
  if (isNone(u)) return null;
  const host = u.replace(/^https?:\/\//i, '').split(/[/?#]/)[0].toLowerCase();
  if (/(^|\.)mouser\./.test(host)) return 'mouser';
  if (/(^|\.)digikey\./.test(host)) return 'digikey';
  if (/(^|\.)lcsc\.com$/.test(host)) return 'lcsc';
  return 'other';
}

/** What one supplier said about the item. */
export type SupplierFind =
  // link: the supplier's product page; discovered: found by searching the
  // supplier for the part number (the item had nothing of theirs).
  | { status: 'found'; mpn: string | null; supplierPn?: string | null; link?: string | null; discovered?: boolean }
  | { status: 'none' }    // the supplier has nothing for it (no number, no link, or not found)
  | { status: 'error'; message: string }; // couldn't ask: keep what is there

export interface ItemSlots { man: string[]; sup: string[]; web: string[] }

const five = (list: unknown[] | undefined) => Array.from({ length: 5 }, (_, i) => String(list?.[i] ?? '').trim());

/** Places the extra values in the free "other" slots (4-5); null when they don't fit. */
function placeExtras(target: Array<string | null>, extras: string[]): Array<string | null> | null {
  const out = [...target];
  for (const v of extras) {
    const free = [3, 4].find((i) => out[i] === null);
    if (free === undefined) return null;
    out[free] = v;
  }
  return out;
}

/** The lined-up slots and notes on what couldn't be done. */
export function alignItem(current: ItemSlots, found: Partial<Record<SlotSupplier, SupplierFind>>): { slots: ItemSlots; notes: string[] } {
  const notes: string[] = [];
  const cur = { man: five(current.man), sup: five(current.sup), web: five(current.web) };

  // Web links: each supplier's page in its slot, everything else to 4-5.
  let web: string[] = cur.web;
  {
    const target: Array<string | null> = [null, null, null, null, null];
    const extras: string[] = [];
    const links = cur.web.map((v, i) => ({ v, i, whose: linkSupplier(v) })).filter((l) => l.whose);
    for (const [slot, s] of SLOT_SUPPLIERS.entries()) {
      const pick = links.find((l) => l.i === slot && l.whose === s) ?? links.find((l) => l.whose === s);
      if (pick) { target[slot] = pick.v; links.splice(links.indexOf(pick), 1); continue; }
      const f = found[s];
      if (f?.status === 'found' && f.link?.trim()) target[slot] = f.link.trim();
    }
    // What is left keeps a 4-5 slot it is in, else takes a free one.
    for (const l of links) { if (l.i >= 3 && target[l.i] === null) target[l.i] = l.v; else extras.push(l.v); }
    const placed = placeExtras(target, extras);
    if (placed) web = placed.map((v) => v ?? NA);
    else notes.push('More web links than slots: left as they are.');
  }

  // Supplier part numbers: each supplier's number in its slot (the item's,
  // else the one the supplier gave), everything else to 4-5.
  let sup: string[] = cur.sup;
  {
    const target: Array<string | null> = [null, null, null, null, null];
    const values = cur.sup.map((v, i) => ({ v, i })).filter((x) => !isNone(x.v));
    for (const [slot, s] of SLOT_SUPPLIERS.entries()) {
      const pick = values.find((x) => x.i === slot && classifyPartNumberBySupplier(x.v) === s) ?? values.find((x) => classifyPartNumberBySupplier(x.v) === s);
      if (pick) { target[slot] = pick.v; values.splice(values.indexOf(pick), 1); continue; }
      const f = found[s];
      const given = f?.status === 'found' ? f.supplierPn?.trim() : '';
      if (given) { target[slot] = given; continue; }
      // An unrecognised number already in this supplier's slot stays (it may be theirs).
      const there = values.find((x) => x.i === slot);
      if (there) { target[slot] = there.v; values.splice(values.indexOf(there), 1); }
    }
    const extras: string[] = [];
    for (const x of values) { if (x.i >= 3 && target[x.i] === null) target[x.i] = x.v; else extras.push(x.v); }
    const placed = placeExtras(target, extras);
    if (placed) sup = placed.map((v) => v ?? NA);
    else notes.push('More supplier part numbers than slots: left as they are.');
  }

  // Manufacturer part numbers: slot n is what supplier n gave. A supplier
  // that couldn't be asked keeps its slot; any other number moves to 4-5.
  let man: string[] = cur.man;
  {
    const target: Array<string | null> = [null, null, null, null, null];
    for (const [slot, s] of SLOT_SUPPLIERS.entries()) {
      const f = found[s];
      if (f?.status === 'found' && f.mpn?.trim()) target[slot] = f.mpn.trim();
      else if (f?.status === 'error') target[slot] = cur.man[slot] || NA;
      else target[slot] = NA;
    }
    const kept = new Set(target.filter((v): v is string => !!v && v !== NA).map((v) => v.toUpperCase()));
    const supNumbers = new Set(sup.filter((v) => !isNone(v)).map((v) => v.toUpperCase()));
    const extras: string[] = [];
    cur.man.forEach((v, i) => {
      if (isNone(v) || kept.has(v.toUpperCase())) return;
      // A supplier's own number copied here: it is (now) in the supplier slots.
      if (classifyPartNumberBySupplier(v) && supNumbers.has(v.toUpperCase())) return;
      if (i >= 3 && target[i] === null) { target[i] = v; kept.add(v.toUpperCase()); return; }
      if (!extras.some((e) => same(e, v))) extras.push(v);
    });
    const placed = placeExtras(target, extras);
    if (placed) man = placed.map((v) => v ?? NA);
    else notes.push('Manufacturer part numbers that no supplier gave don\'t fit in slots 4-5: left as they are.');
  }

  return { slots: { man, sup, web }, notes };
}

/** Whether two slot sets are the same, ignoring the spelling of "none". */
export function sameSlots(a: ItemSlots, b: ItemSlots): boolean {
  const norm = (v: string) => (isNone(v) ? NA : v.trim());
  return (['man', 'sup', 'web'] as const).every((k) => five(a[k]).every((v, i) => norm(v) === norm(five(b[k])[i])));
}
