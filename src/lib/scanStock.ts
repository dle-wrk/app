// Booking stock in and out from the scanner phone app: reels, packets and
// any other inventory item. The phone scans (or the user types) a code, the
// server says which item it is, and a booking changes that item's stock the
// same way the rest of the app does: inventory.stock, a row in transactions
// (BOOK-IN / BOOK-OUT, with who did it), and the stock places kept in step.
//
//   GET  /api/stock-moves/find?code=   what a scanned or typed code is: the item(s) it matches, with stock
//                                      and where it is; what a supplier reel label says (part, quantity,
//                                      lot, date code); or the stock location with that code
//   POST /api/stock-moves              {direction: IN | OUT, partNumber, quantity, locationId?, lot?, dateCode?,
//                                       reference?, note?, capturedAt?, clientRef?}
//                                      IN: adds to stock; with a location (or a lot) it is put away there,
//                                          otherwise it waits in "No location".
//                                      OUT: takes from stock, refused if there isn't that much; with a location
//                                          it comes from that place (refused if the place holds less),
//                                          otherwise from No location first, then the oldest places.
//                                      clientRef: an id the phone makes up per booking; resending it returns
//                                      the booking already made, so a retry never books twice.
//   GET  /api/stock-moves              ?direction=&part=&user=&from=&to=&page=&pageSize= -> { items, total, page, pageSize }
//
// Booking needs the inventory.update permission (writeAccess area
// "stock-moves"), the same as changing stock on the website.

import type { Express, Response } from 'express';
import { pool, query, queryOne, exec } from './db';
import { moveStock, placesOf } from './stockPlaces';
import { bumpDataVersion } from './dataVersion';

export async function ensureScanStockSchema(): Promise<void> {
  await exec(`CREATE TABLE IF NOT EXISTS scan_stock_moves (
    id SERIAL PRIMARY KEY,
    client_ref TEXT UNIQUE,
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
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await exec(`CREATE INDEX IF NOT EXISTS scan_stock_moves_created_idx ON scan_stock_moves (created_at DESC)`);
  await exec(`CREATE INDEX IF NOT EXISTS scan_stock_moves_part_idx ON scan_stock_moves (part_number)`);
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
  /** Which kind of label it was, for the phone to show. */
  kind: 'supplier-2d' | 'supplier-qr' | 'text';
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
 * Anything else is taken as typed text: a Tracklab stock code, a part
 * number, or a location code.
 */
export function parseScannedCode(raw: unknown): ScannedCode {
  const s = String(raw ?? '').trim();
  const uniq = (xs: (string | undefined | null)[]) => [...new Set(xs.map(x => text(x)).filter(Boolean))];
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
}

/** Checks and tidies a booking from the phone. Throws an error with status 400 saying what is wrong. */
export function parseMoveFields(body: Record<string, unknown>, now = Date.now()): MoveFields {
  const direction = text(body.direction).toUpperCase();
  if (direction !== 'IN' && direction !== 'OUT') throw err(400, 'Say whether this is booking IN or OUT.');
  const partNumber = text(body.partNumber);
  if (!partNumber) throw err(400, 'Scan or choose the item first.');
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
  return {
    direction, partNumber, quantity, locationId: loc, lot, dateCode,
    reference: text(body.reference).slice(0, 120) || null,
    note: text(body.note).slice(0, 300) || null,
    capturedAt, clientRef: ref || null,
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
  return { page, pageSize, direction: d === 'IN' || d === 'OUT' ? d : null, part: text(q.part) || null, user: text(q.user) || null, from: day(q.from), to: day(q.to) };
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
  let matchedBy: 'stock code' | 'part number' | 'search' | null = null;
  for (const c of scanned.candidates) {
    const { rows } = await db.query(`SELECT ${ITEM_COLS} FROM inventory WHERE deleted IS NOT TRUE AND upper(serial_number) = upper($1)`, [c]);
    if (rows.length) { rows.forEach(r => found.set(r.serial_number, r)); matchedBy = 'stock code'; break; }
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
  if (scanned.kind === 'text' && scanned.candidates[0]) {
    const code = scanned.candidates[0].toUpperCase().replace(/\s+/g, '-');
    const { rows: [l] } = await db.query(`SELECT id, code, name, active FROM stock_locations WHERE upper(code) = $1`, [code]);
    if (l) location = { id: l.id, code: l.code, name: l.name, active: l.active };
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
    label: scanned.kind === 'text' ? null : { kind: scanned.kind, partNumbers: scanned.candidates, quantity: scanned.quantity, lot: scanned.lot, dateCode: scanned.dateCode },
    matchedBy,
    exact: matchedBy === 'stock code' || (matchedBy === 'part number' && items.length === 1),
    items,
    location,
  };
}

const toMove = (r: any) => ({
  id: r.id,
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
});

/** Books stock in or out inside the caller's transaction. Returns the saved booking row. */
export async function bookMove(client: Db, f: MoveFields, who: { id: number | null; email: string; name: string }) {
  const { rows: [item] } = await client.query(
    `SELECT serial_number, name, stock FROM inventory WHERE upper(serial_number) = upper($1) AND deleted IS NOT TRUE FOR UPDATE`, [f.partNumber]);
  if (!item) throw err(404, `${f.partNumber} is not an item in Tracklab.`);
  const serial: string = item.serial_number;
  const stock = Number(item.stock) || 0;
  let loc: { id: number; code: string; active: boolean } | null = null;
  if (f.locationId !== null) {
    const { rows: [l] } = await client.query(`SELECT id, code, active FROM stock_locations WHERE id = $1`, [f.locationId]);
    if (!l) throw err(400, 'That location no longer exists.');
    if (f.direction === 'IN' && !l.active) throw err(400, `Location ${l.code} is marked inactive. Choose another.`);
    loc = l;
  }
  const reference = movementReference(f, loc?.code ?? null);
  const trxId = `TRX-SCAN-${f.direction}-${serial}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

  if (f.direction === 'OUT') {
    if (f.quantity > stock) throw err(409, stock > 0 ? `Only ${stock} of ${serial} in stock.` : `${serial} has no stock to book out.`);
    if (loc) {
      // From this place: its bins oldest first. The stock update below then finds the
      // places already in step, so the trigger takes nothing more.
      const { rows: bins } = await client.query(
        `SELECT id, qty, lot FROM stock_bins WHERE serial_number = $1 AND location_id = $2 ORDER BY received_at, id FOR UPDATE`, [serial, loc.id]);
      const there = bins.reduce((s, b) => s + Number(b.qty), 0);
      if (f.quantity > there) throw err(409, there > 0 ? `Only ${there} of ${serial} at ${loc.code}.` : `No ${serial} at ${loc.code}.`);
      let left = f.quantity;
      for (const b of bins) {
        if (left <= 0) break;
        const take = Math.min(left, Number(b.qty));
        if (take >= Number(b.qty)) await client.query(`DELETE FROM stock_bins WHERE id = $1`, [b.id]);
        else await client.query(`UPDATE stock_bins SET qty = qty - $2 WHERE id = $1`, [b.id, take]);
        await client.query(
          `INSERT INTO stock_bin_moves (serial_number, bin_id, location_id, lot, qty, reason, reference, by_user) VALUES ($1, $2, $3, $4, $5, 'used', $6, $7)`,
          [serial, b.id, loc.id, b.lot, -take, reference, who.email]);
        left -= take;
      }
    }
    await client.query(`UPDATE inventory SET stock = stock - $2 WHERE serial_number = $1`, [serial, f.quantity]);
  } else {
    await client.query(`UPDATE inventory SET stock = COALESCE(stock, 0) + $2 WHERE serial_number = $1`, [serial, f.quantity]);
    if (loc || f.lot || f.dateCode) {
      await moveStock(client as any, serial, { qty: f.quantity, fromBinId: null, toLocationId: loc?.id ?? null, lot: f.lot, dateCode: f.dateCode, reason: 'booked in', reference, by: who.email });
    }
  }
  const signed = f.direction === 'IN' ? f.quantity : -f.quantity;
  await client.query(
    `INSERT INTO transactions (trxId, itemPartNumber, itemName, type, qtyChange, reference, performedBy, dateTime)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [trxId, serial, item.name || serial, f.direction === 'IN' ? 'BOOK-IN' : 'BOOK-OUT', signed, reference, who.name, new Date().toISOString()]);
  const { rows: [saved] } = await client.query(
    `INSERT INTO scan_stock_moves (client_ref, direction, part_number, item_name, quantity, stock_after, location_id, location_code, lot, date_code,
                                   reference, note, trx_id, user_id, user_email, user_name, captured_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
    [f.clientRef, f.direction, serial, item.name || serial, f.quantity, stock + signed, loc?.id ?? null, loc?.code ?? null, f.lot, f.dateCode,
     f.reference, f.note, trxId, who.id, who.email, who.name, f.capturedAt]);
  return toMove(saved);
}

// ---------------------------------------------------------------------------
// Routes.
// ---------------------------------------------------------------------------

const fail = (res: Response, e: any, what: string) => {
  if (e?.status && e.status < 500) return res.status(e.status).json({ error: e.message });
  console.error(`[stock-moves] ${what} failed:`, e?.message);
  res.status(500).json({ error: `Could not ${what}. Please try again.` });
};

export function registerScanStockRoutes(app: Express): void {
  // Before the list route's siblings so "find" is never read as anything else.
  app.get('/api/stock-moves/find', async (req, res) => {
    try {
      const code = String(req.query.code ?? '');
      if (!code.trim()) return res.status(400).json({ error: 'Scan or type a code to look up.' });
      if (code.length > 2000) return res.status(400).json({ error: 'That code is too long to be a label.' });
      res.json(await findByCode(pool, code));
    } catch (e) { fail(res, e, 'look up the code'); }
  });

  app.post('/api/stock-moves', async (req: any, res) => {
    const client = await pool.connect();
    try {
      const f = parseMoveFields(req.body || {});
      if (f.clientRef) {
        const { rows: [dup] } = await client.query(`SELECT * FROM scan_stock_moves WHERE client_ref = $1`, [f.clientRef]);
        if (dup) return res.status(200).json({ ...toMove(dup), alreadySaved: true });
      }
      const me = await queryOne<{ email: string; first_name: string | null; last_name: string | null }>(
        `SELECT email, first_name, last_name FROM users WHERE id = $1`, [req.user.id]);
      const name = [me?.first_name, me?.last_name].filter(Boolean).join(' ') || me?.email || req.user.email;
      await client.query('BEGIN');
      let move;
      try {
        move = await bookMove(client, f, { id: req.user.id, email: req.user.email, name });
      } catch (e: any) {
        await client.query('ROLLBACK');
        // The same resend arriving twice at once: the other copy won, hand back its booking.
        if (e?.code === '23505' && f.clientRef) {
          const { rows: [dup] } = await client.query(`SELECT * FROM scan_stock_moves WHERE client_ref = $1`, [f.clientRef]);
          if (dup) return res.status(200).json({ ...toMove(dup), alreadySaved: true });
        }
        throw e;
      }
      await client.query('COMMIT');
      void bumpDataVersion('inventory'); // open web tabs re-read stock
      res.status(201).json(move);
    } catch (e) {
      fail(res, e, 'book the stock');
    } finally {
      client.release();
    }
  });

  app.get('/api/stock-moves', async (req, res) => {
    try {
      const f = parseMoveListQuery(req.query as any);
      const where: string[] = [];
      const params: any[] = [];
      const add = (sql: string, v: any) => { params.push(v); where.push(sql.replace(/\?/g, `$${params.length}`)); };
      if (f.direction) add(`direction = ?`, f.direction);
      if (f.part) add(`(part_number ILIKE ? OR item_name ILIKE ?)`, like(f.part));
      if (f.user) add(`(user_name ILIKE ? OR user_email ILIKE ?)`, like(f.user));
      if (f.from) add(`COALESCE(captured_at, created_at) >= ?::date`, f.from);
      if (f.to) add(`COALESCE(captured_at, created_at) < ?::date + 1`, f.to);
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const { rows: [{ n }] } = await query(`SELECT count(*)::int AS n FROM scan_stock_moves ${w}`, params);
      const { rows } = await query(
        `SELECT * FROM scan_stock_moves ${w} ORDER BY COALESCE(captured_at, created_at) DESC, id DESC LIMIT ${f.pageSize} OFFSET ${(f.page - 1) * f.pageSize}`, params);
      res.json({ items: rows.map(toMove), total: n, page: f.page, pageSize: f.pageSize });
    } catch (e) { fail(res, e, 'load the bookings'); }
  });
}
