// Web-link slots that hold something other than a link: a product page's
// title pasted in ("TPD4E001DCKR TEXAS INSTRUMENTS | MOUSER SOUTH AFRICA"), a
// supplier part number ("511-STPS40L45CG") or a supplier's name ("CET
// CIRCUITS"). For each, what to do instead, worked out from the item's own
// part numbers (no supplier is asked):
//   - a copy of a link the item already has in that supplier's slot: cleared
//   - the supplier's page, from its part number: put in the supplier's slot
//     (1 Mouser, 2 DigiKey, 3 LCSC), and the slot it was in cleared
//   - a supplier's name: moved to the Supplier field when that is empty
// Anything else is listed for a person. Cleared slots say N/A.

import { classifyPartNumberBySupplier, looksLikeName, type SlotSupplier } from './partNumbers';

export interface LinkItem { serial_number: string; supplier?: string | null; [k: string]: unknown }
export interface LinkChange { field: string; from: string; to: string }
export interface LinkFix { serialNumber: string; problem: string; why: string; changes: LinkChange[]; supplier?: string }

const OWN: Record<SlotSupplier, number> = { mouser: 0, digikey: 1, lcsc: 2 };
const NAME: Record<SlotSupplier, string> = { mouser: 'Mouser', digikey: 'DigiKey', lcsc: 'LCSC' };
const NONE = /^(|N\/?A|NA|-|NONE)$/i;
export const isLink = (v: string) => /^https?:\/\//i.test(v.trim());
const blank = (v: string) => NONE.test(v.trim());

/** A supplier's product page from its own part number. */
export function supplierLink(supplier: SlotSupplier, pn: string): string {
  const p = encodeURIComponent(pn.trim());
  if (supplier === 'mouser') return `https://www.mouser.co.za/ProductDetail/${p}`;
  if (supplier === 'digikey') return `https://www.digikey.co.za/en/products/result?keywords=${p}`;
  return `https://www.lcsc.com/product-detail/${pn.trim().toUpperCase()}.html`;
}

/** Whose page a pasted title is, from the site name at its end. */
export function titleSupplier(title: string): SlotSupplier | null {
  const t = title.toUpperCase();
  if (/\bMOUSER\b/.test(t)) return 'mouser';
  if (/\bDIGI-?KEY\b/.test(t)) return 'digikey';
  if (/\bLCSC\b/.test(t)) return 'lcsc';
  return null;
}

/** What to do about one item's web-link slots that aren't links; null when they all are. */
export function linkFixFor(r: LinkItem): LinkFix | null {
  const web = [1, 2, 3, 4, 5].map((n) => String(r[`weblink_${n}`] ?? '').trim());
  const sup = [1, 2, 3, 4, 5].map((n) => String(r[`sup_pn_${n}`] ?? '').trim());
  const after = [...web];
  const changes: LinkChange[] = [];
  const problems: string[] = []; const whys: string[] = []; const left: string[] = [];
  let supplier: string | undefined;
  const set = (i: number, to: string) => { if (after[i] !== to) { after[i] = to; } };
  // A supplier's part number on the item: the one in its own slot first.
  const numberOf = (s: SlotSupplier) => [sup[OWN[s]], ...sup].find((v) => v && classifyPartNumberBySupplier(v) === s) ?? null;

  web.forEach((v, i) => {
    if (blank(v) || isLink(v)) return;
    const asNumber = classifyPartNumberBySupplier(v);
    const whose: SlotSupplier | null = asNumber ?? titleSupplier(v);
    if (whose) {
      const s = OWN[whose];
      problems.push(asNumber ? `${NAME[whose]} part number in web link ${i + 1}` : `${NAME[whose]} page title in web link ${i + 1}`);
      if (s !== i && isLink(after[s])) { set(i, 'N/A'); whys.push(`web link ${s + 1} already has ${NAME[whose]}'s page`); return; }
      const pn = asNumber ? v : numberOf(whose);
      if (!pn) { left.push(`no ${NAME[whose]} part number to make its link from`); return; }
      set(s, supplierLink(whose, pn));
      if (s !== i) set(i, 'N/A');
      whys.push(`${NAME[whose]}'s page from ${pn}${s !== i ? `, in web link ${s + 1}` : ''}`);
      return;
    }
    if (looksLikeName(v)) {
      problems.push(`a supplier's name in web link ${i + 1}`);
      if (blank(String(r.supplier ?? ''))) { supplier = v; whys.push('moved to the Supplier field'); } else whys.push(`cleared (the Supplier field says ${r.supplier})`);
      set(i, 'N/A');
      return;
    }
    problems.push(`web link ${i + 1} isn't a link`); left.push(`can't tell whose "${v.slice(0, 40)}" is`);
  });

  if (!problems.length) return null;
  after.forEach((to, i) => { if (to !== web[i]) changes.push({ field: `weblink_${i + 1}`, from: web[i], to }); });
  return {
    serialNumber: r.serial_number, problem: problems.join('; '),
    why: [...whys, ...left.map((l) => `needs a person: ${l}`)].join('; '), changes, ...(supplier ? { supplier } : {}),
  };
}
