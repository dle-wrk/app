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

/** The same rules in TypeScript, over the ten fields in order (man_pn_1..5, sup_pn_1..5). */
export function pickPartNumbers(values: Array<string | null | undefined>): { partNumber: string | null; lcscCode: string | null } {
  const trimmed = values.map((v) => (v ?? '').trim());
  const lcscCode = trimmed.find((v) => LCSC_CODE_RE.test(v))?.toUpperCase() ?? null;
  const real = trimmed.find((v) => v !== '' && !PLACEHOLDER_PART_NUMBERS.includes(v.toUpperCase()) && /[0-9]/.test(v) && !LCSC_CODE_RE.test(v));
  return { partNumber: real ?? lcscCode, lcscCode };
}
