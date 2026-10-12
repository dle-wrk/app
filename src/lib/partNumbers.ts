// Which of an item's part-number fields to price it by.
//
// An inventory item has five manufacturer part-number fields (man_pn_1..5)
// and five supplier ones (sup_pn_1..5: Mouser, DigiKey, LCSC, ...). Many hold
// things that are not part numbers: placeholders ("N/A", "Generic", "NOT
// ASSIGNED") and supplier names typed into the supplier fields ("Digikey",
// "LCSC", "COMMUNICA", "MICRO ROBOTICS"). A supplier keyword search on those
// matches random parts (six fuses were matched to a $130 part via
// "COMMUNICA"), so they are never used. A real part number virtually always
// contains a digit, which rules out every name and placeholder found in the
// data in one go; the placeholder list catches the few with digits.
//
// LCSC part numbers ("C" + digits) are kept apart: LCSC can only be asked by
// its own part number (its search is closed to servers), while the other
// suppliers would keyword-match an LCSC number to unrelated parts. So an item
// is priced by its first real part number, with its LCSC number (if it has
// one) used for LCSC; an item with only an LCSC number is priced by that,
// from LCSC alone.
//
// Shared by bulk pricing (selection and the log) and the live price lookup's
// stock-code translation, so both read an item the same way.

/** Values that mean "no part number", compared upper-cased. */
export const PLACEHOLDER_PART_NUMBERS = ['N/A', 'NA', 'N', 'GENERIC', '-', 'NOT ASSIGNED', 'TBA', 'TBD', 'NONE', 'UNKNOWN', 'NIL', 'NULL', '0'];

/** An LCSC part number: C followed by digits. */
export const LCSC_CODE_RE = /^C\d+$/i;

const SLOTS = (alias: string) =>
  `ARRAY[${[1, 2, 3, 4, 5].map((n) => `${alias}.man_pn_${n}`).concat([1, 2, 3, 4, 5].map((n) => `${alias}.sup_pn_${n}`)).join(', ')}]`;

const PLACEHOLDER_LIST = PLACEHOLDER_PART_NUMBERS.map((p) => `'${p.replace(/'/g, "''")}'`).join(', ');
const USABLE = `COALESCE(TRIM(v), '') <> '' AND UPPER(TRIM(v)) NOT IN (${PLACEHOLDER_LIST}) AND TRIM(v) ~ '[0-9]'`;
const IS_LCSC = `TRIM(v) ~* '^C[0-9]+$'`;

/** SQL for the item's LCSC part number (upper-cased), or NULL. `alias` is the inventory table's alias. */
export function lcscCodeSql(alias = 'i'): string {
  return `(SELECT UPPER(TRIM(v)) FROM unnest(${SLOTS(alias)}) WITH ORDINALITY AS t(v, n) WHERE ${IS_LCSC} ORDER BY n LIMIT 1)`;
}

/**
 * SQL for the part number an item is priced by: its first real part number
 * that isn't an LCSC number (manufacturer fields first, then supplier
 * fields), else its LCSC number. NULL when it has neither.
 */
export function partNumberSql(alias = 'i'): string {
  return `COALESCE(
    (SELECT TRIM(v) FROM unnest(${SLOTS(alias)}) WITH ORDINALITY AS t(v, n) WHERE ${USABLE} AND NOT (${IS_LCSC}) ORDER BY n LIMIT 1),
    ${lcscCodeSql(alias)})`;
}

/**
 * The "none" markers the app itself writes: "N/A" when an item is saved
 * without a supplier, "Generic" without a manufacturer. Harmless, and left
 * alone by the part-number review.
 */
export const NONE_MARKERS = ['N/A', 'NA', 'N', 'GENERIC', '-'];

/** The ten part-number fields, in the order they are read. */
export const PART_NUMBER_FIELDS = ['man_pn_1', 'man_pn_2', 'man_pn_3', 'man_pn_4', 'man_pn_5', 'sup_pn_1', 'sup_pn_2', 'sup_pn_3', 'sup_pn_4', 'sup_pn_5'] as const;
export type PartNumberField = typeof PART_NUMBER_FIELDS[number];

/** Whether a value can be sent to a supplier as a part number. */
export function isUsablePartNumber(value: string | null | undefined): boolean {
  const v = (value ?? '').trim();
  return v !== '' && !PLACEHOLDER_PART_NUMBERS.includes(v.toUpperCase()) && /[0-9]/.test(v);
}

/**
 * A name rather than a part number: no digit, and not a placeholder. In a
 * supplier part-number field that is almost always the supplier, which the
 * item form used to save there ("Digikey", "MICRO ROBOTICS").
 */
export function looksLikeName(value: string | null | undefined): boolean {
  const v = (value ?? '').trim();
  return v !== '' && !/[0-9]/.test(v) && !PLACEHOLDER_PART_NUMBERS.includes(v.toUpperCase());
}

/**
 * The item's preferred supplier, for display: the supplier field, else a
 * supplier name still kept in a supplier part-number field. Never a part
 * number. Null when there is none.
 */
export function preferredSupplier(supplierField: string | null | undefined, supplierPartNumbers: Array<string | null | undefined>): string | null {
  const field = (supplierField ?? '').trim();
  if (field && !NONE_MARKERS.includes(field.toUpperCase())) return field;
  return supplierPartNumbers.map((v) => (v ?? '').trim()).find((v) => looksLikeName(v)) ?? null;
}

/** The same rules in TypeScript, over the ten fields in order (man_pn_1..5, sup_pn_1..5). */
export function pickPartNumbers(values: Array<string | null | undefined>): { partNumber: string | null; lcscCode: string | null } {
  const trimmed = values.map((v) => (v ?? '').trim());
  const lcscCode = trimmed.find((v) => LCSC_CODE_RE.test(v))?.toUpperCase() ?? null;
  const real = trimmed.find((v) => isUsablePartNumber(v) && !LCSC_CODE_RE.test(v));
  return { partNumber: real ?? lcscCode, lcscCode };
}

// ---------------------------------------------------------------------------
// Supplier part-number slots. Supplier part number 1 is Mouser's, 2 DigiKey's,
// 3 LCSC's, 4 and 5 any other supplier's: the Supplier BOM Generator and the
// BOM exports read them by slot. classifyPartNumberBySupplier tells whose a
// number looks like, so the item form can point out one in the wrong slot.
// ---------------------------------------------------------------------------
export type SlotSupplier = 'mouser' | 'digikey' | 'lcsc';

export const SUPPLIER_SLOTS: Array<{ supplier: SlotSupplier | null; label: string }> = [
  { supplier: 'mouser', label: 'Mouser' },
  { supplier: 'digikey', label: 'DigiKey' },
  { supplier: 'lcsc', label: 'LCSC' },
  { supplier: null, label: 'Other' },
  { supplier: null, label: 'Other' },
];

// LCSC: C followed by digits (C123456). DigiKey: ends with -ND (283-…-ND).
// Mouser: a numeric prefix and a hyphen (504-…, 683-…).
export function classifyPartNumberBySupplier(pn: string): SlotSupplier | null {
  const s = String(pn || '').trim();
  if (!s) return null;
  if (/^C\d+$/i.test(s)) return 'lcsc';
  if (/-ND$/i.test(s)) return 'digikey';
  if (/^\d{2,4}-\S+/.test(s)) return 'mouser';
  return null;
}

/** The slot (0-based) a supplier part number belongs in, when it isn't the one it is in; else null. */
export function rightSlotFor(pn: string, slot: number): number | null {
  const supplier = classifyPartNumberBySupplier(pn);
  if (!supplier) return null;
  const right = SUPPLIER_SLOTS.findIndex((s) => s.supplier === supplier);
  return right === slot ? null : right;
}

/**
 * Supplier part-number slots rearranged so each recognised number is in its
 * supplier's slot (the first of each supplier's; a second one goes to slot
 * 4-5). Every other value stays where it is if that slot
 * is still free, else moves to the first free slot of 4-5, then 1-3; none
 * is dropped. Returns null when they don't fit, or the slots unchanged when
 * nothing is out of place.
 */
export function arrangeSupplierSlots(slots: string[]): string[] | null {
  const values = Array.from({ length: SUPPLIER_SLOTS.length }, (_, i) => String(slots[i] ?? '').trim());
  const target: Array<string | null> = values.map(() => null);
  const placed = new Set<number>();
  // Each supplier's number: the one already in its slot, else its first.
  for (const [slot, { supplier }] of SUPPLIER_SLOTS.entries()) {
    if (!supplier) continue;
    const own = classifyPartNumberBySupplier(values[slot]) === supplier ? slot
      : values.findIndex((v, i) => !placed.has(i) && classifyPartNumberBySupplier(v) === supplier && SUPPLIER_SLOTS[i].supplier !== supplier);
    if (own >= 0) { target[slot] = values[own]; placed.add(own); }
  }
  const rest = values.map((v, i) => ({ v, i })).filter(({ v, i }) => v && !placed.has(i));
  const overflow: string[] = [];
  for (const { v, i } of rest) {
    // A recognised number left over (a supplier's second) doesn't stay in
    // another supplier's slot, where downloads would take it for theirs.
    const recognised = classifyPartNumberBySupplier(v) !== null && SUPPLIER_SLOTS[i].supplier !== null;
    if (target[i] === null && !recognised) target[i] = v; else overflow.push(v);
  }
  const free = [3, 4, 0, 1, 2].filter((i) => target[i] === null);
  for (const v of overflow) {
    const i = free.shift();
    if (i === undefined) return null;
    target[i] = v;
  }
  return target.map((v) => v ?? '');
}
