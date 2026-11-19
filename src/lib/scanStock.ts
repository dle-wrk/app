// Booking stock in and out with the scanner (the phone page at /scan, or the
// scanner phone app): reels, packets and any other inventory item. The phone
// scans (or the user types) a code, the server says which item it is, and
// the scan is saved as PENDING. Nothing changes in stock until someone
// approves it on the website (Sales > Scanner). Approving changes the item's
// stock the same way the rest of the app does: inventory.stock, a row in
// transactions (BOOK-IN / BOOK-OUT, under the name of the person who
// scanned), and the stock places kept in step. Rejecting changes nothing.
//
//   GET  /api/stock-moves/find?code=   what a scanned or typed code is: the item(s) it matches, with stock
//                                      and where it is; what a supplier reel label says (part, quantity,
//                                      lot, date code); or the stock location with that code
//   POST /api/stock-moves              {direction: IN | OUT, partNumber, quantity, locationId?, lot?, dateCode?,
//                                       reference?, note?, capturedAt?, clientRef?} -> the scan, status PENDING
//                                      A book-out for more than is in stock now is refused (409).
//                                      clientRef: an id the phone makes up per scan; resending it returns
//                                      the scan already saved, so a retry never saves it twice.
//                                      Booking in something not in Tracklab: send newItem {partNumber (the
//                                      new stock code), name, makerPartNumber?, description?} instead of an
//                                      existing partNumber, plus code (what was scanned); or an existing
//                                      partNumber with code and saveBarcode: true to link the label to it.
//                                      Either is saved with the scan and done only on approval: the item is
//                                      created, the label's codes go in item_barcodes, so find knows them next time.
//                                      poItemId: received against that purchase order line (IN only; the item
//                                      must be the line's part); kitId: picked for that saved kit (OUT only; the
//                                      item must be on its pick list, kitPickList).
//   GET  /api/stock-moves/purchase-orders[/:id]   orders still to receive; one order's lines (received, waiting)
//   GET  /api/stock-moves/kits[/:id]              saved kits; one kit's pick list (where each code is, what's sent)
//   POST /api/stock-moves/decide       {ids: [..], decision: APPROVE | REJECT, reason?}
//                                      -> { results: [{id, ok, error?, move?}], done, failed }
//                                      APPROVE, IN: adds to stock; with a location (or a lot) it is put away
//                                          there, otherwise it waits in "No location". On a PO line, the
//                                          line's qty_received goes up and the order's status follows (receiveOnPo).
//                                      APPROVE, OUT: takes from stock, refused if there isn't that much now;
//                                          with a location it comes from that place (refused if the place
//                                          holds less), otherwise from No location first, then the oldest places.
//   GET  /api/stock-moves              ?status=&direction=&part=&user=&mine=1&from=&to=&page=&pageSize=
//                                      -> { items, total, pending, page, pageSize }
//
// Scanning and deciding both need the inventory.update permission
// (writeAccess area "stock-moves"), the same as changing stock on the website.
import type { Express, Response } from 'express';
import { pool, query, queryOne, exec } from './db';
import { moveStock, placesOf } from './stockPlaces';
import { bumpDataVersion } from './dataVersion';
import { readBin, readReel } from './reelLabel';
import { isDnfCode } from './dnf';

export async function ensureScanStockSchema(): Promise<void> {
  await exec(`CREATE TABLE IF NOT EXISTS scan_stock_moves (
    id SERIAL PRIMARY KEY,
    client_ref TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
    direction TEXT NOT NULL CHECK (direction IN ('IN','OUT')),
    part_number TEXT NOT NULL,
    item_name TEXT,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    stock_after INTEGER,
    location_id INTEGER REFERENCES stock_locations(id) ON DELETE SET NULL,
    location_code TEXT,
    lot TEXT,
    date_code TEXT,
    reference TEXT,
    note TEXT,
    trx_id TEXT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    user_email TEXT,
    user_name TEXT,
    captured_at TIMESTAMPTZ,
    decided_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    decided_by_email TEXT,
    decided_by_name TEXT,
    decided_at TIMESTAMPTZ,
    reject_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await exec(`CREATE INDEX IF NOT EXISTS scan_stock_moves_status_idx ON scan_stock_moves (status)`);
  await exec(`CREATE INDEX IF NOT EXISTS scan_stock_moves_created_idx ON scan_stock_moves (created_at DESC)`);
  await exec(`CREATE INDEX IF NOT EXISTS scan_stock_moves_part_idx ON scan_stock_moves (part_number)`);
  // A book-in of something not in Tracklab yet: the item to create (new_item)
  // and the barcodes to remember (link_codes), both only on approval.
  await exec(`ALTER TABLE scan_stock_moves ADD COLUMN IF NOT EXISTS new_item JSONB`);
  await exec(`ALTER TABLE scan_stock_moves ADD COLUMN IF NOT EXISTS link_codes TEXT[]`);
  // Barcodes learned from the scanner: a scanned code that isn't a stock code
  // or a saved part number, linked to the item it belongs to.
  await exec(`CREATE TABLE IF NOT EXISTS item_barcodes (
    code TEXT PRIMARY KEY,
    serial_number TEXT NOT NULL,
    added_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await exec(`CREATE INDEX IF NOT EXISTS item_barcodes_serial_idx ON item_barcodes (serial_number)`);
  // A book-in against a purchase order line, or a book-out picked for a kit.
  // No foreign keys: the scan stays the record of what was scanned even if
  // the order or kit is deleted later.
  await exec(`ALTER TABLE scan_stock_moves ADD COLUMN IF NOT EXISTS po_item_id INTEGER`);
  await exec(`ALTER TABLE scan_stock_moves ADD COLUMN IF NOT EXISTS po_id INTEGER`);
  await exec(`ALTER TABLE scan_stock_moves ADD COLUMN IF NOT EXISTS po_number TEXT`);
  await exec(`ALTER TABLE scan_stock_moves ADD COLUMN IF NOT EXISTS kit_id INTEGER`);
  await exec(`ALTER TABLE scan_stock_moves ADD COLUMN IF NOT EXISTS kit_name TEXT`);
  await exec(`CREATE INDEX IF NOT EXISTS scan_stock_moves_po_item_idx ON scan_stock_moves (po_item_id) WHERE po_item_id IS NOT NULL`);
  await exec(`CREATE INDEX IF NOT EXISTS scan_stock_moves_kit_idx ON scan_stock_moves (kit_id) WHERE kit_id IS NOT NULL`);
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested).
// ---------------------------------------------------------------------------

const err = (status: number, message: string) => Object.assign(new Error(message), { status });
const text = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();

export interface ScannedCode {
  /** What to look the item up by, best first: maker's part number, supplier's part number, the text itself. */
  candidates: string[];
  quantity: number | null;
  lot: string | null;
  dateCode: string | null;
  /** Which kind of label it was, for the phone to show: a supplier's, Tracklab's own reel or bin label, or plain text. */
  kind: 'supplier-2d' | 'supplier-qr' | 'tracklab' | 'place' | 'text';
  /** The stock location on a Tracklab bin label, or where a Tracklab reel label says the reel was put away. */
  place?: string | null;
}

const wholeQty = (v: string | undefined) => { const n = Number(String(v ?? '').replace(/[^\d]/g, '')); return Number.isInteger(n) && n > 0 && n <= 10_000_000 ? n : null; };

/**
 * Reads what a barcode scanner returned. Supplier reel labels carry more
 * than a part number:
 *  - the 2D code on DigiKey, Mouser, Farnell and most makers' labels
 *    (ISO 15434: starts "[)>", fields split by the GS control character,
 *    each tagged: 1P maker's part, P or 30P the supplier's, Q quantity,
 *    1T lot, 9D / 10D date code);
 *  - the QR code on LCSC / JLCPCB bags: {pbn:…,on:…,pc:C2040,pm:STM32…,qty:10,…}.
 * Tracklab's own labels (./reelLabel): a bin label "LOC:A1-03", a reel
 * label "TL:CAP-024?lot=…&dc=…&qty=…&at=…".
 * Anything else is taken as typed text: a Tracklab stock code, a part
 * number, or a location code.
 */
export function parseScannedCode(raw: unknown): ScannedCode {
  const s = String(raw ?? '').trim();
  const uniq = (xs: (string | undefined | null)[]) => [...new Set(xs.map(x => text(x)).filter(Boolean))];
  const bin = readBin(s);
  if (bin) return { candidates: [], quantity: null, lot: null, dateCode: null, kind: 'place', place: bin };
  const reel = readReel(s);
  if (reel) return { candidates: uniq([reel.code]), quantity: reel.qty ?? null, lot: reel.lot ?? null, dateCode: reel.dateCode ?? null, kind: 'tracklab', place: reel.place ?? null };
  if (s.startsWith('[)>')) {
    // Fields are split by control characters (GS, RS, EOT); each starts with
    // its tag: up to two digits and a letter ("1P", "Q", "30P", "10D").
    const tags = new Map<string, string>();
    for (const field of s.slice(3).split(/[\x00-\x1f]+/)) {
      const m = /^(\d{0,2}[A-Z])(.+)$/.exec(field.trim());
      if (m && !tags.has(m[1])) tags.set(m[1], m[2]);
    }
    const tagged = (id: string) => tags.get(id);
    const maker = tagged('1P');
    const supplier = tagged('30P') ?? tagged('P');
    const fields = [...tags].map(([id, v]) => id + v);
    return {
      candidates: uniq([maker, supplier]),
      quantity: wholeQty(fields.find(f => /^Q\d/.test(f))?.slice(1)),
      lot: text(tagged('1T')) || null,
      dateCode: text(tagged('9D') ?? tagged('10D')) || null,
      kind: 'supplier-2d',
    };
  }
  const qr = /^\{\s*([a-z]+\s*:.*)\}$/is.exec(s);
  if (qr && /\b(pm|pc)\s*:/i.test(qr[1])) {
    const map = new Map<string, string>();
    for (const part of qr[1].split(',')) { const i = part.indexOf(':'); if (i > 0) map.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim()); }
    return { candidates: uniq([map.get('pm'), map.get('pc')]), quantity: wholeQty(map.get('qty')), lot: null, dateCode: null, kind: 'supplier-qr' };
  }
  return { candidates: uniq([s.slice(0, 120)]), quantity: null, lot: null, dateCode: null, kind: 'text' };
}

export const MOVE_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export type MoveStatus = typeof MOVE_STATUSES[number];

export interface MoveFields {
  direction: 'IN' | 'OUT';
  partNumber: string;
  quantity: number;
  locationId: number | null;
  lot: string | null;
  dateCode: string | null;
  reference: string | null;
  note: string | null;
  capturedAt: string | null;
  clientRef: string | null;
  /** Booking in something not in Tracklab yet: the item to create when the scan is approved. */
  newItem: NewItem | null;
  /** Barcodes to save on the item when approved, so the next scan of this label finds it. */
  linkCodes: string[];
  /** A book-in received against this purchase order line. */
  poItemId: number | null;
  /** A book-out picked for this saved kit. */
  kitId: number | null;
}

export interface NewItem { partNumber: string; name: string; description: string | null; makerPartNumber: string | null }

/** A new stock code as typed on the phone: capitals, spaces as dashes. */
export const tidyStockCode = (v: unknown) => text(v).toUpperCase().replace(/\s+/g, '-');
const STOCK_CODE = /^[A-Z0-9][A-Z0-9._\/-]{1,59}$/;

/** The codes in a scan worth remembering as barcodes (no placeholders like "N/A"), at most 4. */
export function barcodesIn(raw: unknown): string[] {
  return parseScannedCode(raw).candidates.map(c => c.toUpperCase()).filter(c => !isPlaceholder(c)).slice(0, 4);
}

/** Checks and tidies a booking from the phone. Throws an error with status 400 saying what is wrong. */
export function parseMoveFields(body: Record<string, unknown>, now = Date.now()): MoveFields {
  const direction = text(body.direction).toUpperCase();
  if (direction !== 'IN' && direction !== 'OUT') throw err(400, 'Say whether this is booking IN or OUT.');
  const partNumber = text(body.partNumber);
  if (!partNumber && !(body.newItem && typeof body.newItem === 'object')) throw err(400, 'Scan or choose the item first.');
  const quantity = Number(text(body.quantity));
  if (!Number.isInteger(quantity) || quantity <= 0) throw err(400, 'Enter a whole quantity of 1 or more.');
  if (quantity > 10_000_000) throw err(400, 'That quantity is too large.');
  const loc = body.locationId === null || body.locationId === undefined || body.locationId === '' ? null : Number(body.locationId);
  if (loc !== null && (!Number.isInteger(loc) || loc <= 0)) throw err(400, 'That location is not valid.');
  const lot = text(body.lot).slice(0, 80) || null;
  const dateCode = text(body.dateCode).slice(0, 40) || null;
  if (direction === 'OUT' && (lot || dateCode)) throw err(400, 'A lot or date code is only recorded when booking in.');
  let capturedAt: string | null = null;
  const t = Date.parse(String(body.capturedAt ?? ''));
  if (Number.isFinite(t) && t <= now + 5 * 60_000 && t > now - 366 * 86_400_000) capturedAt = new Date(t).toISOString();
  const ref = text(body.clientRef);
  if (ref && !/^[A-Za-z0-9._:-]{8,80}$/.test(ref)) throw err(400, 'clientRef must be 8 to 80 letters, digits or . _ : -');

  let newItem: NewItem | null = null;
  const ni = body.newItem;
  if (ni && typeof ni === 'object') {
    if (direction !== 'IN') throw err(400, 'A new item can only be booked in.');
    const n = ni as Record<string, unknown>;
    const code = tidyStockCode(n.partNumber);
    if (!STOCK_CODE.test(code)) throw err(400, 'Give the new item a stock code: 2 to 60 letters, digits, dashes, dots or slashes.');
    const name = text(n.name).slice(0, 200);
    if (!name) throw err(400, 'Give the new item a name.');
    const maker = text(n.makerPartNumber).slice(0, 120);
    newItem = { partNumber: code, name, description: text(n.description).slice(0, 500) || null, makerPartNumber: maker && !isPlaceholder(maker) ? maker : null };
  }
  // The scanned label's codes are remembered on the item when asked (a new item, or "link to an existing item").
  const code = typeof body.code === 'string' && body.code.length <= 2000 ? body.code : '';
  const linkCodes = code && (newItem || body.saveBarcode === true) ? barcodesIn(code).filter(c => c !== (newItem?.partNumber ?? partNumber).toUpperCase()) : [];
  const id = (v: unknown, what: string) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw err(400, `That ${what} is not valid.`);
    return n;
  };
  const poItemId = id(body.poItemId, 'purchase order line');
  const kitId = id(body.kitId, 'kit');
  if (poItemId && direction !== 'IN') throw err(400, 'Stock received on a purchase order is booked in.');
  if (kitId && direction !== 'OUT') throw err(400, 'Stock picked for a kit is booked out.');

  return {
    direction, partNumber: newItem ? newItem.partNumber : partNumber, quantity, locationId: loc, lot, dateCode,
    reference: text(body.reference).slice(0, 120) || null,
    note: text(body.note).slice(0, 300) || null,
    capturedAt, clientRef: ref || null, newItem, linkCodes, poItemId, kitId,
  };
}

/** The reference written on the stock movement, so the item's history says where it came from. */
export function movementReference(f: Pick<MoveFields, 'direction' | 'reference' | 'note'>, locationCode: string | null): string {
  const what = f.reference || f.note || (f.direction === 'IN' ? 'book in' : 'book out');
  return `Scanner: ${what}${locationCode ? ` @ ${locationCode}` : ''}`.slice(0, 200);
}

export function parseMoveListQuery(q: Record<string, unknown>) {
  const page = Math.max(1, Math.floor(Number(q.page)) || 1);
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(q.pageSize)) || 30));
  const day = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : null);
  const d = text(q.direction).toUpperCase();
  const s = text(q.status).toUpperCase();
  // DONE: the history, every scan already approved or rejected.
  const status: MoveStatus | 'DONE' | null = s === 'DONE' ? 'DONE' : (MOVE_STATUSES as readonly string[]).includes(s) ? (s as MoveStatus) : null;
  return { page, pageSize, status, mine: text(q.mine) === '1' || text(q.mine).toLowerCase() === 'true', direction: d === 'IN' || d === 'OUT' ? d : null, part: text(q.part) || null, user: text(q.user) || null, decidedBy: text(q.decidedBy) || null, from: day(q.from), to: day(q.to) };
}

export interface KitBomLine { stock_code: string; qty_per_pcb: number }
export interface KitPick { stock_code: string; allocated_code: string; qty: number }
export interface PickLine { code: string; need: number; forLines: string[] }

/**
 * What to take from the shelves for a saved kit, one line per stock code:
 * each BOM line needs qty per board x the build quantity, taken from the
 * reels picked for it in Kit Booking (its allocations) or, with none, from
 * its own stock code. DNF lines take nothing. The same rules as the kit
 * book-out on the website (./kitBookOut).
 */
export function kitPickList(bom: KitBomLine[], picks: KitPick[], dnf: string[], buildQty: number): PickLine[] {
  const skip = new Set(dnf.map(d => d.toUpperCase()));
  const byLine = new Map<string, KitPick[]>();
  for (const p of picks) {
    if (!(Number(p.qty) > 0)) continue;
    const k = p.stock_code.toUpperCase();
    byLine.set(k, [...(byLine.get(k) ?? []), p]);
  }
  const out = new Map<string, PickLine>();
  const take = (code: string, qty: number, forLine: string) => {
    const k = code.toUpperCase();
    const l = out.get(k) ?? { code, need: 0, forLines: [] };
    l.need += qty;
    if (!l.forLines.includes(forLine)) l.forLines.push(forLine);
    out.set(k, l);
  };
  const seen = new Set<string>();
  for (const b of bom) {
    const line = text(b.stock_code);
    const k = line.toUpperCase();
    // A BOM can list a stock code on several rows (different designators): the kit's picks cover them together.
    if (!line || skip.has(k) || isDnfCode(line)) continue;
    const need = (Number(b.qty_per_pcb) || 0) * Math.max(1, Number(buildQty) || 1);
    if (!(need > 0)) continue;
    const ps = byLine.get(k);
    if (ps?.length) {
      if (seen.has(k)) continue;
      seen.add(k);
      for (const p of ps) take(p.allocated_code, Number(p.qty), line);
    } else take(line, need, line);
  }
  return [...out.values()].sort((a, b) => a.code.localeCompare(b.code));
}

/** A purchase order's status once stock has been received on it: RECEIVED when every line is in full, otherwise PARTIAL. */
export function poStatusAfter(current: string, lines: Array<{ quantity: number; received: number }>): string {
  if (!['DRAFT', 'SENT', 'PARTIAL'].includes(current)) return current;
  const any = lines.some(l => l.received > 0);
  if (!any) return current;
  return lines.every(l => l.received >= l.quantity) ? 'RECEIVED' : 'PARTIAL';
}

// ---------------------------------------------------------------------------
// Database work.
// ---------------------------------------------------------------------------

/** "N/A", "-", "TBD" and the like, which stand in for a missing part number. */
export const isPlaceholder = (s: string) => s.trim().length < 3 || /^(n\/?a|none|nil|tbd|tba|unknown|generic|-+|\?+|x+)$/i.test(s.trim());

type Db = { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> };
const like = (s: string) => `%${s.replace(/[\\%_]/g, '\\$&')}%`;
const PN_COLS = ['man_pn_1', 'man_pn_2', 'man_pn_3', 'man_pn_4', 'man_pn_5', 'sup_pn_1', 'sup_pn_2', 'sup_pn_3', 'sup_pn_4', 'sup_pn_5'];
const ITEM_COLS = `serial_number, name, description, stock, packaging, status, man_pn_1`;

async function itemWithPlaces(db: Db, row: any) {
  const { rows: bins } = await db.query(
    `SELECT b.id, b.location_id, b.lot, b.date_code, b.qty, b.received_at, b.serial_number, l.code, l.name
       FROM stock_bins b LEFT JOIN stock_locations l ON l.id = b.location_id
      WHERE b.serial_number = $1 ORDER BY b.received_at, b.id`, [row.serial_number]);
  const stock = Number(row.stock) || 0;
  const byLocation = new Map<number, { locationId: number; code: string; name: string | null; quantity: number }>();
  for (const b of bins) {
    if (b.location_id == null) continue;
    const at = byLocation.get(b.location_id) ?? { locationId: b.location_id, code: b.code, name: b.name, quantity: 0 };
    at.quantity += Number(b.qty) || 0;
    byLocation.set(b.location_id, at);
  }
  const placedAtLocations = [...byLocation.values()].reduce((s, p) => s + p.quantity, 0);
  return {
    partNumber: row.serial_number,
    name: row.name || row.serial_number,
    description: row.description || null,
    makerPartNumber: row.man_pn_1 || null,
    packaging: row.packaging || null,
    status: row.status || null,
    stock,
    places: [...byLocation.values()],
    noLocation: Math.max(0, stock - placedAtLocations),
    over: placesOf(stock, bins as any).over,
  };
}

/** The item(s) and/or location a scanned or typed code points at. */
export async function findByCode(db: Db, raw: string) {
  const scanned = parseScannedCode(raw);
  const found = new Map<string, any>();
  let matchedBy: 'stock code' | 'barcode' | 'part number' | 'search' | null = null;
  for (const c of scanned.candidates) {
    const { rows } = await db.query(`SELECT ${ITEM_COLS} FROM inventory WHERE deleted IS NOT TRUE AND upper(serial_number) = upper($1)`, [c]);
    if (rows.length) { rows.forEach(r => found.set(r.serial_number, r)); matchedBy = 'stock code'; break; }
  }
  if (!found.size) {
    // A barcode an approved scan linked to an item ("link to an existing item", or a new item made from a scan).
    for (const c of scanned.candidates) {
      if (isPlaceholder(c)) continue;
      const { rows } = await db.query(
        `SELECT ${ITEM_COLS.split(', ').map(col => `i.${col}`).join(', ')} FROM item_barcodes b JOIN inventory i ON i.serial_number = b.serial_number
          WHERE b.code = upper($1) AND i.deleted IS NOT TRUE`, [c]);
      if (rows.length) { rows.forEach(r => found.set(r.serial_number, r)); matchedBy = 'barcode'; break; }
    }
  }
  if (!found.size) {
    for (const c of scanned.candidates) {
      // Many items carry a placeholder instead of a part number; it identifies nothing.
      if (isPlaceholder(c)) continue;
      const { rows } = await db.query(
        `SELECT ${ITEM_COLS} FROM inventory WHERE deleted IS NOT TRUE AND (${PN_COLS.map(col => `upper(trim(${col})) = upper($1)`).join(' OR ')}) ORDER BY serial_number LIMIT 10`, [c]);
      if (rows.length) { rows.forEach(r => found.set(r.serial_number, r)); matchedBy = 'part number'; break; }
    }
  }
  let location: { id: number; code: string; name: string | null; active: boolean } | null = null;
  const placeCode = scanned.kind === 'place' ? scanned.place : scanned.kind === 'text' ? scanned.candidates[0]?.toUpperCase().replace(/\s+/g, '-') : null;
  if (placeCode) {
    const { rows: [l] } = await db.query(`SELECT id, code, name, active FROM stock_locations WHERE upper(code) = $1`, [placeCode]);
    if (l) location = { id: l.id, code: l.code, name: l.name, active: l.active };
  }
  if (scanned.kind === 'text' && scanned.candidates[0]) {
    // Typed text that is nothing exactly: offer the closest items (3+ characters, so "C" doesn't list the store).
    if (!found.size && !location && scanned.candidates[0].length >= 3) {
      const q = like(scanned.candidates[0]);
      const { rows } = await db.query(
        `SELECT ${ITEM_COLS} FROM inventory WHERE deleted IS NOT TRUE
            AND (serial_number ILIKE $1 OR name ILIKE $1 OR description ILIKE $1 OR ${PN_COLS.map(col => `${col} ILIKE $1`).join(' OR ')})
          ORDER BY (serial_number ILIKE $2) DESC, serial_number LIMIT 10`, [q, `${scanned.candidates[0].replace(/[\\%_]/g, '\\$&')}%`]);
      if (rows.length) { rows.forEach(r => found.set(r.serial_number, r)); matchedBy = 'search'; }
    }
  }
  const items = [];
  for (const r of found.values()) items.push(await itemWithPlaces(db, r));
  return {
    code: text(raw).slice(0, 200),
    label: scanned.kind === 'text' || scanned.kind === 'place' ? null
      : { kind: scanned.kind, partNumbers: scanned.candidates, quantity: scanned.quantity, lot: scanned.lot, dateCode: scanned.dateCode, place: scanned.place ?? null },
    matchedBy,
    exact: matchedBy === 'stock code' || matchedBy === 'barcode' || (matchedBy === 'part number' && items.length === 1),
    items,
    location,
    // Nothing found: the codes the phone can save with a new item, or link to an existing one.
    barcodes: found.size || location ? [] : barcodesIn(raw),
  };
}

const toMove = (r: any) => ({
  id: r.id,
  status: r.status as MoveStatus,
  direction: r.direction as 'IN' | 'OUT',
  partNumber: r.part_number,
  itemName: r.item_name,
  quantity: r.quantity,
  stockAfter: r.stock_after,
  location: r.location_code ? { id: r.location_id, code: r.location_code } : null,
  lot: r.lot, dateCode: r.date_code,
  reference: r.reference, note: r.note,
  user: { id: r.user_id, name: r.user_name || r.user_email || 'Unknown', email: r.user_email },
  capturedAt: r.captured_at, createdAt: r.created_at,
  decidedBy: r.decided_by_name || null,
  decidedAt: r.decided_at || null,
  rejectReason: r.reject_reason || null,
  newItem: (r.new_item as NewItem | null) || null,
  linkCodes: (r.link_codes as string[] | null) || [],
  po: r.po_item_id ? { id: r.po_id as number | null, number: r.po_number as string | null, itemId: r.po_item_id as number } : null,
  kit: r.kit_id ? { id: r.kit_id as number, name: r.kit_name as string | null } : null,
});

/** A purchase order line, with its order, for a scan received against it. */
async function poLineFor(client: Db, poItemId: number) {
  const { rows: [l] } = await client.query(
    `SELECT poi.id, poi.part_number, poi.quantity, COALESCE(poi.qty_received, 0) AS received, po.id AS po_id, po.po_number, po.status
       FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.purchase_order_id WHERE poi.id = $1`, [poItemId]);
  return l as { id: number; part_number: string | null; quantity: string; received: string; po_id: number; po_number: string; status: string } | undefined;
}

/** A saved kit and what to pick for it (kitPickList). */
export async function kitPicks(db: Db, kitId: number) {
  const { rows: [kit] } = await db.query(
    `SELECT k.id, k.name, k.build_qty, k.project_id, p.project_name FROM kits k LEFT JOIN projects p ON p.id::text = k.project_id::text WHERE k.id = $1`, [kitId]);
  if (!kit) return null;
  const [{ rows: bom }, { rows: picks }, { rows: dnf }] = await Promise.all([
    db.query(`SELECT stock_code, qty_per_pcb FROM kit_bom WHERE kit_id = $1 ORDER BY id`, [kitId]),
    db.query(`SELECT stock_code, allocated_code, qty FROM kit_allocations WHERE kit_id = $1 ORDER BY id`, [kitId]),
    db.query(`SELECT stock_code FROM kit_dnf WHERE kit_id = $1`, [kitId]),
  ]);
  return { kit, lines: kitPickList(bom, picks, dnf.map((d: any) => d.stock_code), Number(kit.build_qty) || 1) };
}

type Who = { id: number | null; email: string; name: string };

async function itemAndPlace(client: Db, partNumber: string, locationId: number | null, direction: 'IN' | 'OUT', lock: boolean) {
  const { rows: [item] } = await client.query(
    `SELECT serial_number, name, stock FROM inventory WHERE upper(serial_number) = upper($1) AND deleted IS NOT TRUE${lock ? ' FOR UPDATE' : ''}`, [partNumber]);
  if (!item) throw err(404, `${partNumber} is not an item in Tracklab.`);
  const { loc } = await placeOnly(client, locationId, direction);
  return { item, serial: item.serial_number as string, stock: Number(item.stock) || 0, loc };
}

const notEnough = (serial: string, stock: number) => err(409, stock > 0 ? `Only ${stock} of ${serial} in stock.` : `${serial} has no stock to book out.`);

/**
 * Saves a scan from the phone as PENDING. Stock does not change until it is
 * approved. A book-out for more than there is now is refused straight away,
 * so the person scanning finds out at the shelf, not later.
 */
/** An item using this stock code, deleted ones included (their code can't be reused for a new item). */
async function codeTaken(client: Db, code: string) {
  const { rows: [r] } = await client.query(`SELECT serial_number, name, deleted FROM inventory WHERE upper(serial_number) = upper($1)`, [code]);
  return r as { serial_number: string; name: string | null; deleted: boolean | null } | undefined;
}
const takenError = (t: { serial_number: string; name: string | null; deleted: boolean | null }) =>
  err(409, t.deleted ? `${t.serial_number} is the code of a deleted item. Choose another stock code, or restore that item on the website.`
    : `${t.serial_number} is already an item${t.name ? ` (${t.name})` : ''}. Choose another stock code, or link the label to that item instead.`);

export async function recordScan(client: Db, f: MoveFields, who: Who) {
  let serial: string, name: string, stock: number, loc: { id: number; code: string; active: boolean } | null;
  if (f.newItem) {
    const taken = await codeTaken(client, f.newItem.partNumber);
    if (taken) throw takenError(taken);
    ({ loc } = await placeOnly(client, f.locationId, 'IN'));
    serial = f.newItem.partNumber; name = f.newItem.name; stock = 0;
  } else {
    const found = await itemAndPlace(client, f.partNumber, f.locationId, f.direction, false);
    serial = found.serial; name = found.item.name || found.serial; stock = found.stock; loc = found.loc;
  }
  if (f.direction === 'OUT' && f.quantity > stock) throw notEnough(serial, stock);
  let po: { po_id: number; po_number: string } | null = null;
  if (f.poItemId) {
    const l = await poLineFor(client, f.poItemId);
    if (!l) throw err(404, 'That purchase order line no longer exists.');
    if (!['DRAFT', 'SENT', 'PARTIAL'].includes(l.status)) throw err(409, `${l.po_number} is ${l.status.toLowerCase()}: nothing more is received on it.`);
    if (String(l.part_number ?? '').trim().toUpperCase() !== serial.toUpperCase()) throw err(400, `${serial} is not on that line of ${l.po_number}.`);
    po = l;
  }
  let kit: { id: number; name: string } | null = null;
  if (f.kitId) {
    const k = await kitPicks(client, f.kitId);
    if (!k) throw err(404, 'That kit no longer exists.');
    if (!k.lines.some(l => l.code.toUpperCase() === serial.toUpperCase())) throw err(400, `${serial} is not on the pick list for kit ${k.kit.name}.`);
    kit = { id: k.kit.id, name: k.kit.name };
  }
  const reference = f.reference || (po ? po.po_number : kit ? `Kit ${kit.name}` : null);
  // Barcodes already linked to this item are not saved again.
  let linkCodes = f.linkCodes;
  if (linkCodes.length && !f.newItem) {
    const { rows } = await client.query(`SELECT code FROM item_barcodes WHERE code = ANY($1) AND serial_number = $2`, [linkCodes, serial]);
    const have = new Set(rows.map(r => r.code));
    linkCodes = linkCodes.filter(c => !have.has(c));
  }
  const { rows: [saved] } = await client.query(
    `INSERT INTO scan_stock_moves (client_ref, status, direction, part_number, item_name, quantity, location_id, location_code, lot, date_code,
                                   reference, note, user_id, user_email, user_name, captured_at, new_item, link_codes,
                                   po_item_id, po_id, po_number, kit_id, kit_name)
     VALUES ($1,'PENDING',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
    [f.clientRef, f.direction, serial, name, f.quantity, loc?.id ?? null, loc?.code ?? null, f.lot, f.dateCode,
     reference, f.note, who.id, who.email, who.name, f.capturedAt, f.newItem ? JSON.stringify(f.newItem) : null, linkCodes.length ? linkCodes : null,
     f.poItemId, po?.po_id ?? null, po?.po_number ?? null, kit?.id ?? null, kit?.name ?? null]);
  return { ...toMove(saved), stockNow: stock };
}

/**
 * On approval, before the stock moves: creates the new item a scan brought
 * in (refused if its stock code was taken meanwhile), and remembers the
 * label's barcodes on the item. A barcode already linked to another item
 * stays with that one.
 */
async function applyNewItemAndBarcodes(client: Db, row: any, approver: Who) {
  const ni = row.new_item as NewItem | null;
  if (ni) {
    const taken = await codeTaken(client, ni.partNumber);
    if (taken) throw takenError(taken);
    await client.query(
      `INSERT INTO inventory (serial_number, name, description, man_pn_1, stock, status, deleted) VALUES ($1, $2, $3, $4, 0, 'ACTIVE', false)`,
      [ni.partNumber, ni.name, ni.description ?? ni.name, ni.makerPartNumber]);
    await client.query(`INSERT INTO user_activity_logs (user_email, action, entity_type, entity_id, details, status) VALUES ((SELECT email FROM users WHERE email = $1), 'CREATE_ITEM', 'Item', $2, $3, 'SUCCESS')`,
      [approver.email, ni.partNumber, JSON.stringify({ name: ni.name, makerPartNumber: ni.makerPartNumber, from: 'scanner', scannedBy: row.user_email, approvedBy: approver.email })]);
  }
  const codes: string[] = row.link_codes || [];
  for (const c of codes) {
    await client.query(`INSERT INTO item_barcodes (code, serial_number, added_by) VALUES ($1, $2, $3) ON CONFLICT (code) DO NOTHING`, [c, row.part_number, row.user_email || approver.email]);
  }
}

async function placeOnly(client: Db, locationId: number | null, direction: 'IN' | 'OUT') {
  let loc: { id: number; code: string; active: boolean } | null = null;
  if (locationId !== null) {
    const { rows: [l] } = await client.query(`SELECT id, code, active FROM stock_locations WHERE id = $1`, [locationId]);
    if (!l) throw err(400, 'That location no longer exists.');
    if (direction === 'IN' && !l.active) throw err(400, `Location ${l.code} is marked inactive. Choose another.`);
    loc = l;
  }
  return { loc };
}

/**
 * Approves a pending scan inside the caller's transaction: this is where
 * stock changes. The movement is written under the name of the person who
 * scanned it, with who approved it in the reference.
 */
export async function approveScan(client: Db, row: any, approver: Who) {
  const direction = row.direction as 'IN' | 'OUT';
  const quantity = Number(row.quantity);
  await applyNewItemAndBarcodes(client, row, approver);
  const { item, serial, stock, loc } = await itemAndPlace(client, row.part_number, row.location_id ?? null, direction, true);
  const reference = `${movementReference({ direction, reference: row.reference, note: row.note }, loc?.code ?? null)} (approved by ${approver.name})`.slice(0, 250);
  const trxId = `TRX-SCAN-${direction}-${serial}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const scannedBy = row.user_name || row.user_email || approver.name;

  if (direction === 'OUT') {
    if (quantity > stock) throw notEnough(serial, stock);
    if (loc) {
      // From this place: its bins oldest first. The stock update below then finds the
      // places already in step, so the trigger takes nothing more.
      const { rows: bins } = await client.query(
        `SELECT id, qty, lot FROM stock_bins WHERE serial_number = $1 AND location_id = $2 ORDER BY received_at, id FOR UPDATE`, [serial, loc.id]);
      const there = bins.reduce((s, b) => s + Number(b.qty), 0);
      if (quantity > there) throw err(409, there > 0 ? `Only ${there} of ${serial} at ${loc.code}.` : `No ${serial} at ${loc.code}.`);
      let left = quantity;
      for (const b of bins) {
        if (left <= 0) break;
        const take = Math.min(left, Number(b.qty));
        if (take >= Number(b.qty)) await client.query(`DELETE FROM stock_bins WHERE id = $1`, [b.id]);
        else await client.query(`UPDATE stock_bins SET qty = qty - $2 WHERE id = $1`, [b.id, take]);
        await client.query(
          `INSERT INTO stock_bin_moves (serial_number, bin_id, location_id, lot, qty, reason, reference, by_user) VALUES ($1, $2, $3, $4, $5, 'used', $6, $7)`,
          [serial, b.id, loc.id, b.lot, -take, reference, row.user_email || approver.email]);
        left -= take;
      }
    }
    await client.query(`UPDATE inventory SET stock = stock - $2 WHERE serial_number = $1`, [serial, quantity]);
  } else {
    await client.query(`UPDATE inventory SET stock = COALESCE(stock, 0) + $2 WHERE serial_number = $1`, [serial, quantity]);
    if (loc || row.lot || row.date_code) {
      await moveStock(client as any, serial, { qty: quantity, fromBinId: null, toLocationId: loc?.id ?? null, lot: row.lot, dateCode: row.date_code, reason: 'booked in', reference, by: row.user_email || approver.email });
    }
  }
  const signed = direction === 'IN' ? quantity : -quantity;
  await client.query(
    `INSERT INTO transactions (trxId, itemPartNumber, itemName, type, qtyChange, reference, performedBy, dateTime)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [trxId, serial, item.name || serial, direction === 'IN' ? 'BOOK-IN' : 'BOOK-OUT', signed, reference, scannedBy, new Date().toISOString()]);
  if (direction === 'IN' && row.po_item_id) await receiveOnPo(client, Number(row.po_item_id), quantity);
  const { rows: [saved] } = await client.query(
    `UPDATE scan_stock_moves SET status = 'APPROVED', stock_after = $2, trx_id = $3, decided_by_id = $4, decided_by_email = $5, decided_by_name = $6, decided_at = now()
      WHERE id = $1 RETURNING *`,
    [row.id, stock + signed, trxId, approver.id, approver.email, approver.name]);
  return toMove(saved);
}

/**
 * Stock approved on a purchase order line: the line's received quantity goes
 * up, and the order becomes PARTIAL, or RECEIVED once every line is in full
 * (when it was first received is kept, for measured lead times). An order
 * deleted or cancelled since the scan is left alone: the stock still came in.
 */
export async function receiveOnPo(client: Db, poItemId: number, quantity: number) {
  const { rows: [line] } = await client.query(
    `UPDATE purchase_order_items SET qty_received = COALESCE(qty_received, 0) + $2 WHERE id = $1 RETURNING purchase_order_id`, [poItemId, quantity]);
  if (!line) return;
  const { rows: [po] } = await client.query(`SELECT id, status FROM purchase_orders WHERE id = $1 FOR UPDATE`, [line.purchase_order_id]);
  if (!po) return;
  const { rows: lines } = await client.query(
    `SELECT quantity, COALESCE(qty_received, 0) AS received FROM purchase_order_items WHERE purchase_order_id = $1`, [po.id]);
  const next = poStatusAfter(po.status, lines.map((l: any) => ({ quantity: Number(l.quantity) || 0, received: Number(l.received) || 0 })));
  if (next !== po.status) {
    await client.query(
      `UPDATE purchase_orders SET status = $2, received_at = CASE WHEN $2 = 'RECEIVED' THEN COALESCE(received_at, now()) ELSE received_at END WHERE id = $1`,
      [po.id, next]);
  }
}

export interface Decision { ids: number[]; decision: 'APPROVE' | 'REJECT'; reason: string | null }

/** Checks an approve / reject request. Throws an error with status 400 saying what is wrong. */
export function parseDecision(body: Record<string, unknown>): Decision {
  const decision = text(body.decision).toUpperCase();
  if (decision !== 'APPROVE' && decision !== 'REJECT') throw err(400, 'Say whether to APPROVE or REJECT.');
  const raw = Array.isArray(body.ids) ? body.ids : [];
  const ids = [...new Set(raw.map(Number).filter(n => Number.isInteger(n) && n > 0))];
  if (!ids.length) throw err(400, 'Choose at least one scan.');
  if (ids.length > 200) throw err(400, 'Decide 200 scans at most at a time.');
  return { ids, decision, reason: text(body.reason).slice(0, 300) || null };
}

// ---------------------------------------------------------------------------
// Routes.
// ---------------------------------------------------------------------------

const fail = (res: Response, e: any, what: string) => {
  if (e?.status && e.status < 500) return res.status(e.status).json({ error: e.message });
  console.error(`[stock-moves] ${what} failed:`, e?.message);
  res.status(500).json({ error: `Could not ${what}. Please try again.` });
};

async function whoIs(user: { id: number | null; email: string }): Promise<Who> {
  const me = await queryOne<{ email: string; first_name: string | null; last_name: string | null }>(
    `SELECT email, first_name, last_name FROM users WHERE id = $1`, [user.id]);
  return { id: user.id, email: user.email, name: [me?.first_name, me?.last_name].filter(Boolean).join(' ') || me?.email || user.email };
}

export function registerScanStockRoutes(app: Express): void {
  app.get('/api/stock-moves/find', async (req, res) => {
    try {
      const code = String(req.query.code ?? '');
      if (!code.trim()) return res.status(400).json({ error: 'Scan or type a code to look up.' });
      if (code.length > 2000) return res.status(400).json({ error: 'That code is too long to be a label.' });
      res.json(await findByCode(pool, code));
    } catch (e) { fail(res, e, 'look up the code'); }
  });

  // Purchase orders that can still be received (draft, sent or part received), newest first.
  app.get('/api/stock-moves/purchase-orders', async (_req, res) => {
    try {
      const { rows } = await query(
        `SELECT po.id, po.po_number, po.status, po.order_date, po.expected_date, s.name AS supplier,
                COUNT(poi.id)::int AS lines,
                COALESCE(SUM(GREATEST(poi.quantity - COALESCE(poi.qty_received, 0), 0)), 0)::float AS outstanding
           FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id
           LEFT JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
          WHERE po.status IN ('DRAFT', 'SENT', 'PARTIAL')
          GROUP BY po.id, s.name
          ORDER BY (po.status = 'DRAFT'), po.id DESC LIMIT 100`);
      res.json({ items: rows.map((r: any) => ({ id: r.id, number: r.po_number, status: r.status, supplier: r.supplier || null, orderDate: r.order_date, expectedDate: r.expected_date, lines: r.lines, outstanding: Number(r.outstanding) || 0 })) });
    } catch (e) { fail(res, e, 'load the purchase orders'); }
  });

  // One purchase order's lines: ordered, received so far, and waiting for approval on the scanner.
  app.get('/api/stock-moves/purchase-orders/:id', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'That purchase order is not valid.' });
      const { rows: [po] } = await query(
        `SELECT po.id, po.po_number, po.status, po.expected_date, s.name AS supplier FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = $1`, [id]);
      if (!po) return res.status(404).json({ error: 'That purchase order no longer exists.' });
      const { rows } = await query(
        `SELECT poi.id, poi.part_number, poi.description, poi.quantity::float AS quantity, COALESCE(poi.qty_received, 0)::float AS received,
                i.serial_number AS item, i.name AS item_name,
                COALESCE((SELECT SUM(m.quantity) FROM scan_stock_moves m WHERE m.po_item_id = poi.id AND m.status = 'PENDING'), 0)::int AS waiting
           FROM purchase_order_items poi
           LEFT JOIN inventory i ON upper(i.serial_number) = upper(trim(poi.part_number)) AND i.deleted IS NOT TRUE
          WHERE poi.purchase_order_id = $1 ORDER BY poi.id`, [id]);
      res.json({
        id: po.id, number: po.po_number, status: po.status, supplier: po.supplier || null, expectedDate: po.expected_date,
        lines: rows.map((r: any) => ({ id: r.id, partNumber: r.item || (r.part_number ? String(r.part_number).trim() : null), inTracklab: !!r.item, name: r.item_name || null, description: r.description, quantity: r.quantity, received: r.received, waiting: r.waiting })),
      });
    } catch (e) { fail(res, e, 'load the purchase order'); }
  });

  // Saved kits (Kit Booking), newest first.
  app.get('/api/stock-moves/kits', async (_req, res) => {
    try {
      const { rows } = await query(
        `SELECT k.id, k.name, k.build_qty, p.project_name, k.updated_at,
                (SELECT COUNT(*)::int FROM kit_bom b WHERE b.kit_id = k.id) AS lines
           FROM kits k LEFT JOIN projects p ON p.id::text = k.project_id::text ORDER BY k.updated_at DESC NULLS LAST, k.id DESC LIMIT 100`);
      res.json({ items: rows.map((r: any) => ({ id: r.id, name: r.name, buildQty: r.build_qty, project: r.project_name || null, lines: r.lines, updatedAt: r.updated_at })) });
    } catch (e) { fail(res, e, 'load the kits'); }
  });

  // A kit's pick list: each stock code to take, how many, where it is, and what the scanner has already sent for it.
  app.get('/api/stock-moves/kits/:id', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'That kit is not valid.' });
      const k = await kitPicks(pool, id);
      if (!k) return res.status(404).json({ error: 'That kit no longer exists.' });
      const codes = k.lines.map(l => l.code);
      const { rows: items } = await query(`SELECT ${ITEM_COLS} FROM inventory WHERE deleted IS NOT TRUE AND upper(serial_number) = ANY($1::text[])`, [codes.map(c => c.toUpperCase())]);
      const byCode = new Map<string, any>();
      for (const r of items) byCode.set(String(r.serial_number).toUpperCase(), await itemWithPlaces(pool, r));
      const { rows: sent } = await query(
        `SELECT upper(part_number) AS code, status, SUM(quantity)::int AS qty FROM scan_stock_moves WHERE kit_id = $1 AND status IN ('PENDING', 'APPROVED') GROUP BY 1, 2`, [id]);
      const sum = (code: string, status: string) => sent.filter((s: any) => s.code === code.toUpperCase() && s.status === status).reduce((t: number, s: any) => t + s.qty, 0);
      res.json({
        id: k.kit.id, name: k.kit.name, buildQty: Number(k.kit.build_qty) || 1, project: k.kit.project_name || null,
        lines: k.lines.map(l => {
          const it = byCode.get(l.code.toUpperCase()) ?? null;
          return { code: it?.partNumber ?? l.code, need: l.need, forLines: l.forLines, item: it, waiting: sum(l.code, 'PENDING'), bookedOut: sum(l.code, 'APPROVED') };
        }),
      });
    } catch (e) { fail(res, e, 'load the kit'); }
  });

  app.post('/api/stock-moves', async (req: any, res) => {
    try {
      const f = parseMoveFields(req.body || {});
      const already = async () => {
        if (!f.clientRef) return null;
        const { rows: [dup] } = await query(`SELECT * FROM scan_stock_moves WHERE client_ref = $1`, [f.clientRef]);
        return dup ? { ...toMove(dup), alreadySaved: true } : null;
      };
      const dup = await already();
      if (dup) return res.status(200).json(dup);
      try {
        res.status(201).json(await recordScan(pool, f, await whoIs(req.user)));
      } catch (e: any) {
        // The same resend arriving twice at once: the other copy won, hand back its scan.
        const late = e?.code === '23505' ? await already() : null;
        if (late) return res.status(200).json(late);
        throw e;
      }
    } catch (e) { fail(res, e, 'save the scan'); }
  });

  // Approve or reject pending scans. Each scan is decided in its own
  // transaction, so one that can't be approved (not enough stock now)
  // doesn't hold back the rest; the answer says what happened to each.
  app.post('/api/stock-moves/decide', async (req: any, res) => {
    try {
      const d = parseDecision(req.body || {});
      const approver = await whoIs(req.user);
      const results: Array<{ id: number; ok: boolean; error?: string; move?: ReturnType<typeof toMove> }> = [];
      for (const id of d.ids) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const { rows: [row] } = await client.query(`SELECT * FROM scan_stock_moves WHERE id = $1 FOR UPDATE`, [id]);
          if (!row) throw err(404, 'That scan no longer exists.');
          if (row.status !== 'PENDING') throw err(409, `Already ${row.status === 'APPROVED' ? 'approved' : 'rejected'}${row.decided_by_name ? ` by ${row.decided_by_name}` : ''}.`);
          let move;
          if (d.decision === 'APPROVE') move = await approveScan(client, row, approver);
          else {
            const { rows: [saved] } = await client.query(
              `UPDATE scan_stock_moves SET status = 'REJECTED', reject_reason = $2, decided_by_id = $3, decided_by_email = $4, decided_by_name = $5, decided_at = now()
                WHERE id = $1 RETURNING *`, [id, d.reason, approver.id, approver.email, approver.name]);
            move = toMove(saved);
          }
          await client.query('COMMIT');
          results.push({ id, ok: true, move });
        } catch (e: any) {
          await client.query('ROLLBACK').catch(() => {});
          if (!(e?.status && e.status < 500)) console.error('[stock-moves] decide failed:', e?.message);
          results.push({ id, ok: false, error: e?.status && e.status < 500 ? e.message : 'Something went wrong. Try again.' });
        } finally {
          client.release();
        }
      }
      if (d.decision === 'APPROVE' && results.some(r => r.ok)) void bumpDataVersion('inventory'); // open web tabs re-read stock
      res.json({ results, done: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length });
    } catch (e) { fail(res, e, 'decide the scans'); }
  });

  app.get('/api/stock-moves', async (req, res) => {
    try {
      const f = parseMoveListQuery(req.query as any);
      const where: string[] = [];
      const params: any[] = [];
      const add = (sql: string, v: any) => { params.push(v); where.push(sql.replace(/\?/g, `$${params.length}`)); };
      if (f.status === 'DONE') where.push(`status <> 'PENDING'`);
      else if (f.status) add(`status = ?`, f.status);
      if (f.direction) add(`direction = ?`, f.direction);
      if (f.part) add(`(part_number ILIKE ? OR item_name ILIKE ?)`, like(f.part));
      if (f.user) add(`(user_name ILIKE ? OR user_email ILIKE ?)`, like(f.user));
      if (f.decidedBy) add(`(decided_by_name ILIKE ? OR decided_by_email ILIKE ?)`, like(f.decidedBy));
      if (f.mine) add(`user_id = ?`, (req as any).user.id);
      if (f.from) add(`COALESCE(captured_at, created_at) >= ?::date`, f.from);
      if (f.to) add(`COALESCE(captured_at, created_at) < ?::date + 1`, f.to);
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const { rows: [{ n }] } = await query(`SELECT count(*)::int AS n FROM scan_stock_moves ${w}`, params);
      const { rows: [{ pending }] } = await query(`SELECT count(*)::int AS pending FROM scan_stock_moves WHERE status = 'PENDING'`);
      const { rows } = await query(
        `SELECT * FROM scan_stock_moves ${w} ORDER BY COALESCE(captured_at, created_at) DESC, id DESC LIMIT ${f.pageSize} OFFSET ${(f.page - 1) * f.pageSize}`, params);
      res.json({ items: rows.map(toMove), total: n, pending, page: f.page, pageSize: f.pageSize });
    } catch (e) { fail(res, e, 'load the scans'); }
  });
}
