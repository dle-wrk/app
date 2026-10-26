// DNF ("do not fit") and its relatives: BOM lines for positions left empty on
// the board. They are never a shortage, never ordered and never booked out.
// A stock code is DNF when it is DNF or DNP on its own or followed by a
// separator or number (DNF-013, DNP_2, DNF1), or spelled out (DO NOT FIT,
// DO NOT POPULATE). Used by the Bill of Materials, Kit Booking and their
// shortage, order and book-out paths alike.

const DNF_CODE = /^(DNF|DNP)([-_ ./]|\d|$)|^DO\s*NOT\s*(FIT|POPULATE|PLACE)\b/i;

export function isDnfCode(code: unknown): boolean {
  return DNF_CODE.test(String(code ?? '').trim());
}
