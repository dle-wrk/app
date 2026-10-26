// Things in an item's data that disagree with each other, for a person to
// check (nothing here changes anything):
//   - a capacitor's or resistor's value in its name vs its description, and
//     vs the value coded in a Yageo part number (CC0402…BB104 is 100nF,
//     RC0402FR-0710KL is 10K)
//   - the LCSC number in Sup PN 3 vs the LCSC number in web link 3
//   - two numbers from one supplier that are nearly the same (581-AEF… and
//     581-AEK…): one is likely a typo. Different numbers are often alternates,
//     and LCSC codes that are close mean nothing, so those aren't flagged.
//   - a supplier's slot (Sup PN 1 Mouser, 2 DigiKey, 3 LCSC) holding something
//     that isn't that supplier's number, nor a copy of the manufacturer's
// Resistor values with M are skipped: in descriptions "MOHM" is used for
// milliohms as well as megohms.

import { classifyPartNumberBySupplier, type SlotSupplier } from './partNumbers';

export interface CheckItem { serial_number: string; name?: string | null; description?: string | null; [k: string]: unknown }
export interface DataCheck { serialNumber: string; name: string; kind: 'value' | 'lcsc_link' | 'two_numbers' | 'wrong_slot_value'; detail: string }

const NONE = /^(|N\/?A|NA|-|NONE|GENERIC)$/i;
const val = (v: unknown) => { const t = String(v ?? '').trim(); return NONE.test(t) ? '' : t; };
const PF: Record<string, number> = { P: 1, N: 1e3, U: 1e6, 'µ': 1e6, M: 1e9 };

/** A capacitance in pF from "10UF", "100NF", "2U2F", "0.1UF", "4.7 uF"; null when there is none or two different. */
export function capacitance(text: string): number | null {
  const found = new Set<number>();
  for (const m of text.toUpperCase().matchAll(/(?<![A-Z0-9.,])(\d+)([PNUµ])(\d+)F?(?![A-Z0-9])/g)) found.add(Number(`${m[1]}.${m[3]}`) * PF[m[2]]);
  for (const m of text.toUpperCase().matchAll(/(?<![A-Z0-9.,])(\d+(?:[.,]\d+)?)\s*([PNUµ])F(?![A-Z0-9])/g)) found.add(Number(m[1].replace(',', '.')) * PF[m[2]]);
  const all = [...found].map((n) => Math.round(n * 1000) / 1000);
  return all.length && all.every((n) => n === all[0]) ? all[0] : null;
}

/** A resistance in ohms from "1K5", "4K7", "100R", "49,9R", "10K", "1.5K OHM", "100 OHM"; M values are skipped. */
export function resistance(text: string): number | null {
  const t = text.toUpperCase();
  if (/\d\s*M(\b|R|Ω|OHM)/.test(t)) return null; // milli- or mega-: can't tell
  const found = new Set<number>();
  for (const m of t.matchAll(/(?<![A-Z0-9.,])(\d+)([RK])(\d+)(?![A-Z0-9])/g)) found.add(Number(`${m[1]}.${m[3]}`) * (m[2] === 'K' ? 1e3 : 1));
  for (const m of t.matchAll(/(?<![A-Z0-9.,])(\d+(?:[.,]\d+)?)\s*(K|R)(?:\s*OHMS?|Ω)?(?![A-Z0-9])/g)) found.add(Number(m[1].replace(',', '.')) * (m[2] === 'K' ? 1e3 : 1));
  for (const m of t.matchAll(/(?<![A-Z0-9.,])(\d+(?:[.,]\d+)?)\s*(K)?\s*(?:OHMS?|Ω)(?![A-Z0-9])/g)) found.add(Number(m[1].replace(',', '.')) * (m[2] ? 1e3 : 1));
  const all = [...found].map((n) => Math.round(n * 1000) / 1000);
  return all.length && all.every((n) => n === all[0]) ? all[0] : null;
}

/** The value a Yageo part number codes: CC…BB104 is 100 000 pF, RC0402FR-0710KL is 10 000 ohms. */
export function yageoValue(pn: string): { kind: 'cap' | 'res'; value: number } | null {
  const p = pn.trim().toUpperCase();
  const cc = p.match(/^CC\d{4}[A-Z]{2}[A-Z0-9]{3,4}BB(\d)(\d)(\d)$/);
  if (cc) return { kind: 'cap', value: Number(`${cc[1]}${cc[2]}`) * 10 ** Number(cc[3]) };
  const rc = p.match(/^R[CT]\d{4}[A-Z]{2}-\d{2}(\d+)([RK])(\d*)L$/);
  if (rc) return { kind: 'res', value: Number(`${rc[1]}.${rc[3] || 0}`) * (rc[2] === 'K' ? 1e3 : 1) };
  return null;
}

/** How many single-character edits turn a into b. */
export function editDistance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
  }
  return d[b.length];
}

const showPf = (pf: number) => (pf >= 1e6 ? `${pf / 1e6}uF` : pf >= 1e3 ? `${pf / 1e3}nF` : `${pf}pF`);
const showOhm = (o: number) => (o >= 1e3 ? `${o / 1e3}K` : `${o}R`);
const OWN: SlotSupplier[] = ['mouser', 'digikey', 'lcsc'];
const SUPPLIER: Record<SlotSupplier, string> = { mouser: 'Mouser', digikey: 'DigiKey', lcsc: 'LCSC' };

export function checkItem(r: CheckItem): DataCheck[] {
  const out: DataCheck[] = [];
  const name = String(r.name ?? '').trim();
  const desc = String(r.description ?? '');
  const man = [1, 2, 3, 4, 5].map((n) => val(r[`man_pn_${n}`]));
  const sup = [1, 2, 3, 4, 5].map((n) => val(r[`sup_pn_${n}`]));
  const web = [1, 2, 3, 4, 5].map((n) => val(r[`weblink_${n}`]));
  const add = (kind: DataCheck['kind'], detail: string) => out.push({ serialNumber: r.serial_number, name, kind, detail });

  // 1. Values: name vs description, name vs a Yageo part number.
  const isCap = /^CAP\b/i.test(r.serial_number);
  const isRes = /^RES\b/i.test(r.serial_number);
  if (isCap || isRes) {
    const read = isCap ? capacitance : resistance;
    const show = isCap ? showPf : showOhm;
    const nv = read(name); const dv = read(desc);
    if (nv !== null && dv !== null && nv !== dv) add('value', `Named ${name}, but the description says ${show(dv)} ("${desc.slice(0, 60)}").`);
    for (const pn of new Set(man.filter(Boolean))) {
      const y = yageoValue(pn);
      if (!y || (y.kind === 'cap') !== isCap) continue;
      const against = nv ?? dv;
      if (against !== null && y.value !== against) add('value', `${pn} is ${show(y.value)}, but the item is ${show(against)}${nv !== null ? ` (named ${name})` : ' (by its description)'}.`);
    }
  }

  // 2. LCSC number vs LCSC link.
  const lcscPn = sup.find((v) => classifyPartNumberBySupplier(v) === 'lcsc');
  const lcscInLink = web.map((u) => u.match(/lcsc\.com\/product-detail\/(?:[^?#]*_)?(C\d+)\.html/i)?.[1]?.toUpperCase()).find(Boolean);
  if (lcscPn && lcscInLink && lcscPn.toUpperCase() !== lcscInLink) add('lcsc_link', `LCSC number ${lcscPn}, but the LCSC link is for ${lcscInLink}.`);

  // 3. Two numbers from one supplier, nearly the same: a typo in one of them.
  for (const s of ['mouser', 'digikey'] as SlotSupplier[]) {
    const nums = [...new Set([...sup, ...man].filter((v) => classifyPartNumberBySupplier(v) === s).map((v) => v.toUpperCase()))];
    for (let a = 0; a < nums.length; a++) for (let b = a + 1; b < nums.length; b++) {
      if (nums[a].length >= 8 && editDistance(nums[a], nums[b]) <= 2) add('two_numbers', `Two ${SUPPLIER[s]} numbers that nearly match: ${nums[a]} and ${nums[b]}. One may be a typo.`);
    }
  }

  // 4. A supplier's slot holding something else.
  OWN.forEach((s, i) => {
    const v = sup[i];
    if (!v || classifyPartNumberBySupplier(v) === s) return;
    if (man.some((m) => m && m.toUpperCase() === v.toUpperCase())) return; // a copy of the manufacturer's number: harmless
    const whose = classifyPartNumberBySupplier(v);
    add('wrong_slot_value', `Sup PN ${i + 1} is ${SUPPLIER[s]}'s slot, but holds ${v}${whose ? ` (${SUPPLIER[whose]}'s)` : ', which isn\'t a ' + SUPPLIER[s] + ' number'}.`);
  });
  return out;
}

export const checkItems = (rows: CheckItem[]) => rows.flatMap(checkItem);
