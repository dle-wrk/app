// What Tracklab's own labels hold, shared by the label printer (web) and the
// scanner's lookup (server, ./scanStock).
//
//   Bin label:   LOC:A1-03
//   Reel label:  TL:CAP-024?lot=L2431&dc=2431&qty=5000&at=A1-03
//                the stock code, then whatever is known of the reel: lot,
//                date code, quantity on it and where it was put away.
//                Plain ASCII, so a keyboard-style scanner types it as is.

export const BIN_PREFIX = 'LOC:';
export const REEL_PREFIX = 'TL:';

export interface Reel { code: string; lot?: string | null; dateCode?: string | null; qty?: number | null; place?: string | null }

export function reelPayload(r: Reel): string {
  const q = new URLSearchParams();
  if (r.lot) q.set('lot', r.lot);
  if (r.dateCode) q.set('dc', r.dateCode);
  if (r.qty && r.qty > 0) q.set('qty', String(Math.floor(r.qty)));
  if (r.place) q.set('at', r.place);
  const s = q.toString();
  return `${REEL_PREFIX}${encodeURIComponent(r.code).replace(/%2F/gi, '/')}${s ? `?${s}` : ''}`;
}

/** A reel label's contents, or null when the text isn't one. */
export function readReel(text: string): Reel | null {
  const t = String(text ?? '').trim();
  if (!t.toUpperCase().startsWith(REEL_PREFIX)) return null;
  const rest = t.slice(REEL_PREFIX.length);
  const i = rest.indexOf('?');
  let code: string;
  try { code = decodeURIComponent(i < 0 ? rest : rest.slice(0, i)).trim(); } catch { return null; }
  if (!code) return null;
  const q = new URLSearchParams(i < 0 ? '' : rest.slice(i + 1));
  const n = Number(q.get('qty'));
  return {
    code,
    lot: q.get('lot')?.trim() || null,
    dateCode: q.get('dc')?.trim() || null,
    qty: Number.isInteger(n) && n > 0 && n <= 10_000_000 ? n : null,
    place: q.get('at')?.trim().toUpperCase() || null,
  };
}

/** The location code on a bin label ("LOC:A1-03" -> "A1-03"), or null. */
export function readBin(text: string): string | null {
  const t = String(text ?? '').trim();
  if (!t.toUpperCase().startsWith(BIN_PREFIX)) return null;
  return t.slice(BIN_PREFIX.length).trim().toUpperCase().replace(/\s+/g, '-') || null;
}
