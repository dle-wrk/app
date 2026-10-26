// Where stock is: locations (a store, shelf, bin or reel rack) and the stock
// in each, optionally by lot / date code.
//
//   stock_locations   a place: code ("A1-03"), name, active
//   stock_bins        a quantity of one item at one location (location may be
//                     empty: received but not yet put away), from one lot
//   stock_bin_moves   every change to those quantities: put away, moved,
//                     counted, used, returned; with the database transaction
//                     it happened in, so a use can be traced to the stock
//                     movement (transactions.xact) that caused it
//
// inventory.stock stays the item's total, as everywhere else in the app. What
// isn't in a place is "No location": stock minus what the places hold. When
// stock goes down by any route (an invoice, a kit book-out, an edit), a
// trigger keeps the places in step: what has no location goes first (it is
// the oldest stock, from before places were kept), then the places, oldest
// first, each use logged. A stock count posts with the trigger set aside and
// writes the places itself. Stock going up lands in No location until it is
// put away.

import type { Express } from 'express';
import { pool, query, exec } from './db';
import { requirePermission } from './authRoutes';

export async function ensureStockPlacesSchema(run: (sql: string) => Promise<void> = exec): Promise<void> {
  await run(`CREATE TABLE IF NOT EXISTS stock_locations (
    id SERIAL PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    name TEXT,
    notes TEXT,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await run(`CREATE TABLE IF NOT EXISTS stock_bins (
    id SERIAL PRIMARY KEY,
    serial_number TEXT NOT NULL REFERENCES inventory(serial_number) ON UPDATE CASCADE ON DELETE CASCADE,
    location_id INTEGER REFERENCES stock_locations(id) ON DELETE SET NULL,
    lot TEXT,
    date_code TEXT,
    qty INTEGER NOT NULL CHECK (qty > 0),
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    source TEXT
  )`);
  await run(`CREATE INDEX IF NOT EXISTS stock_bins_item ON stock_bins (serial_number, received_at)`);
  await run(`CREATE INDEX IF NOT EXISTS stock_bins_location ON stock_bins (location_id)`);
  await run(`CREATE TABLE IF NOT EXISTS stock_bin_moves (
    id SERIAL PRIMARY KEY,
    serial_number TEXT NOT NULL,
    bin_id INTEGER,
    location_id INTEGER,
    lot TEXT,
    qty INTEGER NOT NULL,
    reason TEXT NOT NULL,
    reference TEXT,
    by_user TEXT,
    xact BIGINT NOT NULL DEFAULT txid_current(),
    at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await run(`CREATE INDEX IF NOT EXISTS stock_bin_moves_item ON stock_bin_moves (serial_number, at)`);
  await run(`CREATE INDEX IF NOT EXISTS stock_bin_moves_lot ON stock_bin_moves (lot)`);
  // The database transaction each stock movement was written in, to tie a
  // place's use to the movement that caused it.
  await run(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS xact BIGINT DEFAULT txid_current()`);
  await run(`CREATE OR REPLACE FUNCTION stock_bins_follow_stock() RETURNS trigger AS $fn$
    DECLARE excess INTEGER; b RECORD; take INTEGER;
    BEGIN
      IF current_setting('tracklab.places_manual', true) = 'on' THEN RETURN NEW; END IF;
      IF NEW.stock IS NULL OR OLD.stock IS NULL OR NEW.stock >= OLD.stock THEN RETURN NEW; END IF;
      SELECT COALESCE(SUM(qty), 0) - GREATEST(NEW.stock, 0) INTO excess FROM stock_bins WHERE serial_number = NEW.serial_number;
      IF excess <= 0 THEN RETURN NEW; END IF;
      FOR b IN SELECT * FROM stock_bins WHERE serial_number = NEW.serial_number ORDER BY received_at, id FOR UPDATE LOOP
        EXIT WHEN excess <= 0;
        take := LEAST(b.qty, excess);
        IF take >= b.qty THEN DELETE FROM stock_bins WHERE id = b.id;
        ELSE UPDATE stock_bins SET qty = qty - take WHERE id = b.id; END IF;
        INSERT INTO stock_bin_moves (serial_number, bin_id, location_id, lot, qty, reason) VALUES (NEW.serial_number, b.id, b.location_id, b.lot, -take, 'used');
        excess := excess - take;
      END LOOP;
      RETURN NEW;
    END $fn$ LANGUAGE plpgsql`);
  await run(`DROP TRIGGER IF EXISTS stock_bins_follow_stock ON inventory`);
  await run(`CREATE TRIGGER stock_bins_follow_stock AFTER UPDATE OF stock ON inventory FOR EACH ROW EXECUTE FUNCTION stock_bins_follow_stock()`);
}

// ---------------------------------------------------------------------------
// The rules, without a database.

export interface Bin { id: number; serial_number: string; location_id: number | null; lot: string | null; date_code: string | null; qty: number; received_at: string | Date }

/** An item's places, and what has no location: its stock less what the places hold (never below 0). */
export function placesOf(stock: number, bins: Bin[]): { unplaced: number; placed: number; over: number } {
  const placed = bins.reduce((s, b) => s + (Number(b.qty) || 0), 0);
  const total = Number(stock) || 0;
  return { placed, unplaced: Math.max(0, total - placed), over: Math.max(0, placed - total) };
}

const clean = (v: unknown) => { const t = String(v ?? '').trim(); return t || null; };
export const locationCode = (v: unknown) => String(v ?? '').trim().toUpperCase().replace(/\s+/g, '-');

// ---------------------------------------------------------------------------
// Routes.
//   GET    /api/stock-locations                    every location, with how many items and units it holds
//   POST   /api/stock-locations                    {code, name?, notes?}
//   PUT    /api/stock-locations/:id                {code?, name?, notes?, active?}
//   DELETE /api/stock-locations/:id                only an empty one (else mark it inactive)
//   GET    /api/stock-locations/:id/contents       what is in it
//   GET    /api/inventory/:serial/places           an item's places, its No location quantity and recent moves
//   POST   /api/inventory/:serial/places/move      {qty, fromBinId|null, toLocationId|null, lot?, dateCode?}: put away or move
//   GET    /api/lots?q= | ?ref=                    lot tracing: where a lot is and was used; the lots a build or invoice used

type Db = { query: (s: string, p?: any[]) => Promise<any> };

async function itemPlaces(db: Db, serial: string) {
  const { rows: [item] } = await db.query(`SELECT serial_number, name, stock FROM inventory WHERE serial_number = $1 AND deleted IS NOT TRUE`, [serial]);
  if (!item) return null;
  const { rows: bins } = await db.query(
    `SELECT b.*, l.code AS location_code, l.name AS location_name FROM stock_bins b LEFT JOIN stock_locations l ON l.id = b.location_id
      WHERE b.serial_number = $1 ORDER BY b.received_at, b.id`, [serial]);
  return { item, bins, ...placesOf(item.stock, bins) };
}

/** Moves qty of an item from a place (or from No location) to a location (or to No location), keeping its lot. */
export async function moveStock(db: Db, serial: string, m: { qty: number; fromBinId: number | null; toLocationId: number | null; lot?: string | null; dateCode?: string | null; reason?: string; reference?: string | null; by?: string }) {
  const qty = Math.floor(Number(m.qty));
  if (!(qty > 0)) throw Object.assign(new Error('Move a whole number of 1 or more.'), { status: 400 });
  await db.query(`SELECT 1 FROM inventory WHERE serial_number = $1 FOR UPDATE`, [serial]);
  const now = await itemPlaces(db, serial);
  if (!now) throw Object.assign(new Error('Item not found.'), { status: 404 });
  if (m.toLocationId !== null) {
    const { rows } = await db.query(`SELECT id, active FROM stock_locations WHERE id = $1`, [m.toLocationId]);
    if (!rows.length) throw Object.assign(new Error('That location no longer exists.'), { status: 400 });
  }
  let lot = clean(m.lot); let dateCode = clean(m.dateCode); let receivedAt: any = null; let fromLocation: number | null = null;
  if (m.fromBinId !== null) {
    const from = now.bins.find((b: any) => b.id === m.fromBinId);
    if (!from) throw Object.assign(new Error('That place no longer holds this item.'), { status: 409 });
    if (qty > from.qty) throw Object.assign(new Error(`Only ${from.qty} there.`), { status: 400 });
    lot = from.lot; dateCode = from.date_code; receivedAt = from.received_at; fromLocation = from.location_id;
    if (qty === from.qty) await db.query(`DELETE FROM stock_bins WHERE id = $1`, [from.id]);
    else await db.query(`UPDATE stock_bins SET qty = qty - $2 WHERE id = $1`, [from.id, qty]);
  } else if (qty > now.unplaced) {
    throw Object.assign(new Error(`Only ${now.unplaced} without a location.`), { status: 400 });
  }
  if (m.toLocationId !== null || lot || dateCode) {
    // Same item, location and lot as a place already there: added to it.
    const { rows: same } = await db.query(
      `SELECT id FROM stock_bins WHERE serial_number = $1 AND location_id IS NOT DISTINCT FROM $2 AND lot IS NOT DISTINCT FROM $3 AND date_code IS NOT DISTINCT FROM $4 ORDER BY id LIMIT 1`,
      [serial, m.toLocationId, lot, dateCode]);
    if (same.length) await db.query(`UPDATE stock_bins SET qty = qty + $2 WHERE id = $1`, [same[0].id, qty]);
    else await db.query(`INSERT INTO stock_bins (serial_number, location_id, lot, date_code, qty, received_at, source) VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()), $7)`,
      [serial, m.toLocationId, lot, dateCode, qty, receivedAt, m.reason ?? 'put away']);
  }
  await db.query(`INSERT INTO stock_bin_moves (serial_number, bin_id, location_id, lot, qty, reason, reference, by_user) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [serial, m.fromBinId, m.toLocationId ?? fromLocation, lot, qty, m.reason ?? (m.fromBinId === null ? 'put away' : 'moved'), m.reference ?? null, m.by ?? null]);
}

const httpError = (res: any, err: any) => res.status(err.status || 500).json({ error: err.message });

export function registerStockPlacesRoutes(app: Express): void {
  app.get('/api/stock-locations', async (_req, res) => {
    try {
      const { rows } = await query(`SELECT l.*, COUNT(DISTINCT b.serial_number)::int AS items, COALESCE(SUM(b.qty), 0)::int AS units
        FROM stock_locations l LEFT JOIN stock_bins b ON b.location_id = l.id GROUP BY l.id ORDER BY l.active DESC, l.code`);
      const { rows: [u] } = await query(`SELECT COALESCE(SUM(GREATEST(i.stock - COALESCE(p.placed, 0), 0)), 0)::int AS units,
          COUNT(*) FILTER (WHERE i.stock - COALESCE(p.placed, 0) > 0)::int AS items
        FROM inventory i LEFT JOIN (SELECT serial_number, SUM(qty) AS placed FROM stock_bins GROUP BY 1) p USING (serial_number) WHERE i.deleted IS NOT TRUE`);
      res.json({ locations: rows, unplaced: u });
    } catch (err) { httpError(res, err); }
  });

  app.post('/api/stock-locations', async (req, res) => {
    const code = locationCode(req.body?.code);
    if (!code || code.length > 40) return res.status(400).json({ error: 'Give the location a code of up to 40 characters, such as A1-03 or REEL-RACK-2.' });
    try {
      const { rows } = await query(`INSERT INTO stock_locations (code, name, notes) VALUES ($1, $2, $3) RETURNING *`, [code, clean(req.body?.name), clean(req.body?.notes)]);
      res.status(201).json(rows[0]);
    } catch (err: any) {
      if (err.code === '23505') return res.status(409).json({ error: `There is already a location ${code}.` });
      httpError(res, err);
    }
  });

  app.put('/api/stock-locations/:id', async (req, res) => {
    const b = req.body ?? {}; const sets: string[] = []; const p: any[] = [];
    const set = (c: string, v: unknown) => { p.push(v); sets.push(`${c} = $${p.length}`); };
    if (b.code !== undefined) { const code = locationCode(b.code); if (!code) return res.status(400).json({ error: 'A location needs a code.' }); set('code', code); }
    if (b.name !== undefined) set('name', clean(b.name));
    if (b.notes !== undefined) set('notes', clean(b.notes));
    if (b.active !== undefined) set('active', !!b.active);
    if (!sets.length) return res.status(400).json({ error: 'Nothing to change.' });
    try {
      p.push(parseInt(req.params.id));
      const { rows } = await query(`UPDATE stock_locations SET ${sets.join(', ')} WHERE id = $${p.length} RETURNING *`, p);
      if (!rows.length) return res.status(404).json({ error: 'Location not found.' });
      res.json(rows[0]);
    } catch (err: any) {
      if (err.code === '23505') return res.status(409).json({ error: 'Another location has that code.' });
      httpError(res, err);
    }
  });

  app.delete('/api/stock-locations/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { rows: [n] } = await query(`SELECT COUNT(*)::int AS n FROM stock_bins WHERE location_id = $1`, [id]);
      if (n.n > 0) return res.status(409).json({ error: 'It still holds stock: move it out first, or mark the location inactive.' });
      const { rowCount } = await query(`DELETE FROM stock_locations WHERE id = $1`, [id]);
      if (!rowCount) return res.status(404).json({ error: 'Location not found.' });
      res.json({ ok: true });
    } catch (err) { httpError(res, err); }
  });

  app.get('/api/stock-locations/:id/contents', async (req, res) => {
    try {
      const { rows } = await query(`SELECT b.*, i.name, i.description, i.stock FROM stock_bins b JOIN inventory i USING (serial_number)
        WHERE b.location_id = $1 ORDER BY b.serial_number, b.received_at`, [parseInt(req.params.id)]);
      res.json(rows);
    } catch (err) { httpError(res, err); }
  });

  app.get('/api/inventory/:serial/places', async (req, res) => {
    try {
      const p = await itemPlaces({ query: (s, v) => query(s, v) }, req.params.serial);
      if (!p) return res.status(404).json({ error: 'Item not found.' });
      const { rows: moves } = await query(
        `SELECT m.*, l.code AS location_code, t.reference AS movement FROM stock_bin_moves m LEFT JOIN stock_locations l ON l.id = m.location_id
          LEFT JOIN LATERAL (SELECT reference FROM transactions t WHERE m.reason = 'used' AND t.xact = m.xact AND t.itempartnumber = m.serial_number ORDER BY t.id DESC LIMIT 1) t ON true
          WHERE m.serial_number = $1 ORDER BY m.at DESC, m.id DESC LIMIT 50`, [req.params.serial]);
      res.json({ ...p, moves });
    } catch (err) { httpError(res, err); }
  });

  // Lot tracing. GET /api/lots?q=: lots matching q, where each is now and
  // where it was used; or, with ?ref=, the lots used by a stock movement whose
  // reference matches ("Kit TCU06", "Invoice INV-2026-0009").
  app.get('/api/lots', async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const ref = String(req.query.ref ?? '').trim();
    try {
      if (ref) {
        const { rows } = await query(
          `SELECT t.reference, t.datetime, m.serial_number, i.name, m.lot, l.code AS location_code, -m.qty AS qty, m.at
             FROM stock_bin_moves m JOIN transactions t ON t.xact = m.xact AND t.itempartnumber = m.serial_number
             LEFT JOIN stock_locations l ON l.id = m.location_id LEFT JOIN inventory i ON i.serial_number = m.serial_number
            WHERE m.reason = 'used' AND t.reference ILIKE $1 ORDER BY m.at DESC, m.serial_number LIMIT 500`, [`%${ref}%`]);
        return res.json({ used: rows });
      }
      if (q.length < 2) return res.json({ lots: [] });
      const like = `%${q}%`;
      const { rows: now } = await query(
        `SELECT b.lot, b.date_code, b.serial_number, i.name, l.code AS location_code, b.qty, b.received_at
           FROM stock_bins b LEFT JOIN stock_locations l ON l.id = b.location_id LEFT JOIN inventory i USING (serial_number)
          WHERE b.lot ILIKE $1 OR b.date_code ILIKE $1 OR b.serial_number ILIKE $1 ORDER BY b.lot, b.received_at LIMIT 300`, [like]);
      const { rows: used } = await query(
        `SELECT m.lot, m.serial_number, -m.qty AS qty, m.at, l.code AS location_code, t.reference
           FROM stock_bin_moves m LEFT JOIN stock_locations l ON l.id = m.location_id
           LEFT JOIN LATERAL (SELECT reference FROM transactions t WHERE t.xact = m.xact AND t.itempartnumber = m.serial_number ORDER BY t.id DESC LIMIT 1) t ON true
          WHERE m.reason = 'used' AND m.lot IS NOT NULL AND (m.lot ILIKE $1 OR m.serial_number ILIKE $1) ORDER BY m.at DESC LIMIT 500`, [like]);
      res.json({ now, used });
    } catch (err) { httpError(res, err); }
  });

  app.post('/api/inventory/:serial/places/move', requirePermission('inventory.update'), async (req: any, res) => {
    const b = req.body ?? {};
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await moveStock(client, req.params.serial, {
        qty: b.qty, fromBinId: b.fromBinId == null ? null : Number(b.fromBinId), toLocationId: b.toLocationId == null || b.toLocationId === '' ? null : Number(b.toLocationId),
        lot: b.lot, dateCode: b.dateCode, by: req.user?.email,
      });
      const p = await itemPlaces(client, req.params.serial);
      await client.query('COMMIT');
      res.json(p);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      httpError(res, err);
    } finally { client.release(); }
  });
}
