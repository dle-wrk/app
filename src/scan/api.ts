// The scan page's own calls to the Tracklab API. It signs in as a phone
// session (POST /api/mobile/login), which is separate from the website's:
// scanning on a phone never signs the person out of the web app on their
// computer. The token is kept in this browser under its own key.

const TOKEN_KEY = 'scanToken';
const USER_KEY = 'scanUser';

export interface ScanUser { id: number; name: string; email: string; role: string }

export const session = {
  token: (): string | null => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
  user: (): ScanUser | null => { try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; } },
  save(token: string, user: ScanUser) { try { localStorage.setItem(TOKEN_KEY, token); localStorage.setItem(USER_KEY, JSON.stringify(user)); } catch { /* private window: signed in until the page closes */ } memory.token = token; },
  clear() { try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); } catch { /* nothing kept */ } memory.token = null; },
};
const memory: { token: string | null } = { token: null };

/** Thrown for a 401: the token is no longer good and the person must sign in again. */
export class SignedOutError extends Error { constructor() { super('Please sign in again.'); } }

export async function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = memory.token ?? session.token();
  const headers: Record<string, string> = {};
  if (token) headers['X-Session-Id'] = token;
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(path, { method: init.method || 'GET', headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
  } catch {
    throw new Error('No connection. Check the signal and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/mobile/login') { session.clear(); throw new SignedOutError(); }
  if (!res.ok) throw Object.assign(new Error(data?.error || `Something went wrong (${res.status}).`), { status: res.status });
  return data as T;
}

export interface FoundItem {
  partNumber: string; name: string; description: string | null; makerPartNumber: string | null;
  packaging: string | null; status: string | null; stock: number;
  places: { locationId: number; code: string; name: string | null; quantity: number }[];
  noLocation: number;
}
export interface FindResult {
  code: string;
  /** What a supplier's or Tracklab's reel label said; place is where a Tracklab reel label says the reel was put away. */
  label: { kind: string; partNumbers: string[]; quantity: number | null; lot: string | null; dateCode: string | null; place?: string | null } | null;
  matchedBy: string | null;
  exact: boolean;
  items: FoundItem[];
  location: { id: number; code: string; name: string | null; active: boolean } | null;
  /** Nothing found: the codes in the scan that can be saved with a new item or linked to an existing one. */
  barcodes?: string[];
}
export interface NewItem { partNumber: string; name: string; description: string | null; makerPartNumber: string | null }
export interface Move {
  id: number; status: 'PENDING' | 'APPROVED' | 'REJECTED'; direction: 'IN' | 'OUT';
  partNumber: string; itemName: string | null; quantity: number; stockAfter: number | null;
  location: { id: number | null; code: string } | null;
  reference: string | null; note: string | null;
  capturedAt: string | null; createdAt: string;
  decidedBy: string | null; rejectReason: string | null;
  newItem?: NewItem | null; linkCodes?: string[];
  po?: { id: number | null; number: string | null; itemId: number } | null;
  kit?: { id: number; name: string | null } | null;
}
export interface Location { id: number; code: string; name: string | null; active: boolean }

/** A purchase order still to be received, and its lines. */
export interface PoSummary { id: number; number: string; status: string; supplier: string | null; orderDate: string | null; expectedDate: string | null; lines: number; outstanding: number }
export interface PoLine { id: number; partNumber: string | null; inTracklab: boolean; name: string | null; description: string | null; quantity: number; received: number; waiting: number }
export interface PoDetail { id: number; number: string; status: string; supplier: string | null; expectedDate: string | null; lines: PoLine[] }

/** A saved kit, and what to pick for it. */
export interface KitSummary { id: number; name: string; buildQty: number; project: string | null; lines: number }
export interface PickLine { code: string; need: number; forLines: string[]; item: FoundItem | null; waiting: number; bookedOut: number }
export interface KitDetail { id: number; name: string; buildQty: number; project: string | null; lines: PickLine[] }

/** Still to receive on a PO line, or to pick for a kit line, after what is received and waiting. */
export const stillDue = (total: number, done: number, waiting: number) => Math.max(0, total - done - waiting);

/** A stock count (stock take) and its lines. */
export interface CountSummary { id: number; number: string; scope: string; status: string; location_code: string | null; lines: number; counted: number; created_at: string }
export interface CountLine { id: number; serial_number: string; name: string | null; location_id: number | null; location_code: string | null; lot: string | null; date_code: string | null; counted: number | null; added: boolean }
export interface CountDetail { count: CountSummary & { location_id: number | null }; lines: CountLine[] }

/** An id for one scan, sent with it so a retry is never saved twice. */
export const newClientRef = () => {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `web-${rnd}`;
};
