// How well a stock item can stand in for a BOM line's part (Kit Booking and
// the Bill of Materials reel picker, GET /api/kits/match/:code and the batch):
//   T1  the part itself
//   T2  equivalent: an approved alternative, or the same Name + Footprint
//       and, when either has a colour (LEDs), the same colour
//   T3  same Name but the footprint or the colour differs (or one colour is
//       unknown): shown to verify, never auto-filled
//   T4  similar Name: verify carefully
// Colour is the item's Colour field, else read from its name and description
// (./ledColor), so an orange LED's T2 reels are orange.

import { detectLedSwatch, swatchForColour } from './ledColor';

export interface MatchItem { serial_number: string; name?: string | null; description?: string | null; footprint?: string | null; color?: string | null }

const NONE = /^(|n\/?a|none|-|generic)$/i;
const norm = (s: string) => s.toLowerCase().replace(/colour/g, 'color').replace(/[^a-z]/g, '');

/** The item's colour as a label ("Orange", "Yellow-green"), or null when it has none.
 *  The Colour field wins, except when the description names a finer shade of
 *  it: LED-008's field says "green", its description YELLOW GREEN. */
export function itemColour(r: MatchItem): string | null {
  const raw = String(r.color ?? '').trim();
  const own = raw && !NONE.test(raw) ? swatchForColour(raw)?.label ?? raw : null;
  const read = detectLedSwatch({ name: r.name ?? '', description: r.description ?? '', partNumber: r.serial_number })?.label ?? null;
  if (own && read && norm(read) !== norm(own) && norm(read).includes(norm(own))) return read;
  return own ?? read;
}

export const sameColour = (a: string, b: string) => norm(a) === norm(b);

export function matchTier(anchor: MatchItem, cand: MatchItem, approved: Set<string>): { tier: number; note: string } {
  if (cand.serial_number === anchor.serial_number) return { tier: 1, note: 'Exact match (primary SKU)' };
  if (approved.has(cand.serial_number)) return { tier: 2, note: 'Approved alternative (from alternates table)' };
  const aName = String(anchor.name ?? '').trim();
  const name = String(cand.name ?? '').trim();
  if (!aName || !name) return { tier: 0, note: '' };
  const aFp = String(anchor.footprint ?? '').trim();
  const fp = String(cand.footprint ?? '').trim();
  const aCol = itemColour(anchor);
  const col = itemColour(cand);
  const colourNote = aCol || col
    ? !aCol || !col ? `colour unknown (${col ?? '?'} for ${aCol ?? '?'})` : !sameColour(aCol, col) ? `different colour (${col}, not ${aCol})` : null
    : null;
  if (name === aName && fp && aFp && fp === aFp) {
    if (!colourNote) return { tier: 2, note: aCol ? 'Equivalent — same Name + Footprint + Colour' : 'Equivalent — same Name + Footprint' };
    return { tier: 3, note: `Same Name + Footprint, ${colourNote} — verify` };
  }
  if (name === aName) return { tier: 3, note: `Same Name, footprint differs${colourNote ? `, ${colourNote}` : ''} — verify` };
  if (name.includes(aName) || aName.includes(name)) {
    if (!fp || !aFp || fp === aFp) return { tier: 4, note: `Similar Name${colourNote ? `, ${colourNote}` : ''} — verify carefully` };
  }
  return { tier: 0, note: '' };
}
