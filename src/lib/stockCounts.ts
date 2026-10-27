// Stock counts (stock takes): count what is really there and post the
// differences as one audited adjustment.
//
//   POST /api/stock-counts                {scope: 'location'|'unplaced'|'all', locationId?, prefix?, notes?}: start one
//   GET  /api/stock-counts                every count
//   GET  /api/stock-counts/:id            a count and its lines, each with what the system says now
//   PUT  /api/stock-counts/:id/lines      {lines: [{id, counted, note?}]}: enter counts
//   POST /api/stock-counts/:id/lines      {serialNumber, locationId?, lot?}: something found that wasn't listed
//   POST /api/stock-counts/:id/post       post it: each counted place set to its count, stock changed by the difference
//   POST /api/stock-counts/:id/cancel
//   DELETE /api/stock-counts/:id           an open or cancelled count (a posted one is the record of a stock change: kept)
//
// A line is one place (an item at a location, by lot) or an item's stock with
// no location. Its expected quantity is what the system said when the count
// started; posting compares the count with what it says now, so stock that
// moved during the count isn't counted twice. Uncounted lines are left alone.
// Posting writes the places itself (the trigger in ./stockPlaces is set aside
// for it), logs each change as a "counted" move and each item's difference
// as a STOCK-COUNT movement, and records who posted it.

import type { Express } from 'express';
import { pool, query, exec } from './db';
import { requirePermission } from './authRoutes';
import { nextDocNumber } from './bookkeeping-db';

export async function ensureStockCountsSchema(run: (sql: string) => Promise<void> = exec): Promise<void> {
  await run(`CREATE SEQUENCE IF NOT EXISTS stock_count_seq`);
  await run(`CREATE TABLE IF NOT EXISTS stock_counts (
    id SERIAL PRIMARY KEY,
    number TEXT UNIQUE NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('location', 'unplaced', 'all')),
    location_id INTEGER REFERENCES stock_locations(id) ON DELETE SET NULL,
    prefix TEXT,
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'POSTED', 'CANCELLED')),
    notes TEXT,
    created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    posted_by TEXT, posted_at TIMESTAMPTZ,
    summary JSONB
  )`);
  await run(`CREATE TABLE IF NOT EXISTS stock_count_lines (
    id SERIAL PRIMARY KEY,
    count_id INTEGER NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
    serial_number TEXT NOT NULL,
    bin_id INTEGER,
    location_id INTEGER,
    lot TEXT,
    date_code TEXT,
    expected INTEGER NOT NULL DEFAULT 0,
    counted INTEGER,
    note TEXT,
    added BOOLEAN NOT NULL DEFAULT false
  )`);
  await run(`CREATE INDEX IF NOT EXISTS stock_count_lines_count ON stock_count_lines (count_id)`);
}

// ---------------------------------------------------------------------------
// The rules, without a database.

export interface CountLine { id: number; serial_number: string; bin_id: number | null; location_id: number | null; lot: string | null; expected: number; counted: number | null }
export interface NowState { binQty: Map<number, number>; unplaced: Map<string, number> }

/** What the system says a line holds now: its place's quantity, or the item's stock with no location. */
export const nowFor = (l: CountLine, s: NowState) =>
  l.bin_id !== null ? s.binQty.get(l.bin_id) ?? 0 : l.location_id === null && !l.lot ? s.unplaced.get(l.serial_number) ?? 0 : 0;

/** Per item, the stock change posting makes: counted less what the system says now, over its counted lines. */
export function countDifferences(lines: CountLine[], s: NowState): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lines) {
    if (l.counted === null || l.counted === undefined) continue;
    const d = Number(l.counted) - nowFor(l, s);
    if (d) out.set(l.serial_number, (out.get(l.serial_number) ?? 0) + d);
  }
  return out;
}

// ---------------------------------------------------------------------------

type Db = { query: (s: string, p?: any[]) => Promise<any> };
const httpError = (res: any, err: any) => res.status(err.status || 500).json({ error: err.message });
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

async function nowState(db: Db, serials: string[]): Promise<NowState> {
  const { rows: bins } = await db.query(`SELECT id, qty FROM stock_bins WHERE serial_number = ANY($1::text[])`, [serials]);
  const { rows: un } = await db.query(
    `SELECT i.serial_number, GREATEST(i.stock - COALESCE((SELECT SUM(qty) FROM stock_bins b WHERE b.serial_number = i.serial_number), 0), 0)::int AS unplaced
       FROM inventory i WHERE i.serial_number = ANY($1::text[])`, [serials]);
  return { binQty: new Map(bins.map((b: any) => [b.id, b.qty])), unplaced: new Map(un.map((u: any) => [u.serial_number, u.unplaced])) };
}

async function loadCount(db: Db, id: number) {
  const { rows: [count] } = await db.query(`SELECT c.*, l.code AS location_code FROM stock_counts c LEFT JOIN stock_locations l ON l.id = c.location_id WHERE c.id = $1`, [id]);
  if (!count) return null;
  const { rows: lines } = await db.query(
    `SELECT cl.*, i.name, i.description, l.code AS location_code FROM stock_count_lines cl LEFT JOIN inventory i USING (serial_number)
       LEFT JOIN stock_locations l ON l.id = cl.location_id WHERE cl.count_id = $1 ORDER BY l.code NULLS FIRST, cl.serial_number, cl.lot NULLS FIRST, cl.id`, [id]);
  const state = await nowState(db, [...new Set(lines.map((l: any) => l.serial_number))] as string[]);
  return { count, lines: lines.map((l: any) => ({ ...l, now: nowFor(l, state) })) };
}

/** Starts a count: its lines are the places (and stock with no location) in scope, with what the system says now. */
export async function createCount(client: Db, o: { scope: 'location' | 'unplaced' | 'all'; locationId: number | null; prefix: string | null; notes: string | null; by: string | null }) {
  const { scope, locationId, prefix } = o;
  const number = await nextDocNumber(client as any, 'SC', 'stock_count_seq');
  const { rows: [count] } = await client.query(
    `INSERT INTO stock_counts (number, scope, location_id, prefix, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [number, scope, locationId, prefix, o.notes, o.by]);
  const like = prefix ? `${prefix}%` : '%';
  // Places to count.
  if (scope !== 'unplaced') {
    await client.query(
  `INSERT INTO stock_count_lines (count_id, serial_number, bin_id, location_id, lot, date_code, expected)
   SELECT $1, b.serial_number, b.id, b.location_id, b.lot, b.date_code, b.qty FROM stock_bins b JOIN inventory i USING (serial_number)
    WHERE i.deleted IS NOT TRUE AND b.serial_number LIKE $2 AND ($3::int IS NULL OR b.location_id = $3)`,
  [count.id, like, locationId]);
  }
  // Stock with no location: every item that has some (and, counting everything, every item, so nothing is missed).
  if (scope !== 'location') {
    await client.query(
  `INSERT INTO stock_count_lines (count_id, serial_number, expected)
   SELECT $1, i.serial_number, GREATEST(i.stock - COALESCE(p.placed, 0), 0) FROM inventory i
     LEFT JOIN (SELECT serial_number, SUM(qty) AS placed FROM stock_bins GROUP BY 1) p USING (serial_number)
    WHERE i.deleted IS NOT TRUE AND i.serial_number LIKE $2 AND ($3 = 'all' OR i.stock - COALESCE(p.placed, 0) > 0)`,
  [count.id, like, scope]);
  }
  return { id: count.id as number, number };
}

/** Posts a count, in the caller's transaction: counted places set, stock changed by the difference, all logged. */
export async function postCount(client: Db, id: number, who: string) {
  const { rows: [count] } = await client.query(`SELECT * FROM stock_counts WHERE id = $1 FOR UPDATE`, [id]);
  if (!count) throw fail(404, 'Count not found.');
  if (count.status !== 'OPEN') throw fail(409, `This count is ${count.status.toLowerCase()}.`);
  const { rows: lines } = await client.query(`SELECT * FROM stock_count_lines WHERE count_id = $1 AND counted IS NOT NULL ORDER BY id`, [id]);
  if (!lines.length) throw fail(400, 'Nothing has been counted yet.');
  const serials = [...new Set(lines.map((l: any) => l.serial_number))] as string[];
  await client.query(`SELECT 1 FROM inventory WHERE serial_number = ANY($1::text[]) ORDER BY serial_number FOR UPDATE`, [serials]);
  const state = await nowState(client, serials);
  const diffs = countDifferences(lines, state);
  // The places are written here, so the stock trigger stays out of it.
  await client.query(`SET LOCAL tracklab.places_manual = 'on'`);
  const ref = `Stock count ${count.number}`;
  let placesChanged = 0;
  for (const l of lines) {
    const now = nowFor(l, state);
    const d = l.counted - now;
    if (!d) continue;
    placesChanged++;
    if (l.bin_id !== null && state.binQty.has(l.bin_id)) {
      if (l.counted === 0) await client.query(`DELETE FROM stock_bins WHERE id = $1`, [l.bin_id]);
      else await client.query(`UPDATE stock_bins SET qty = $2 WHERE id = $1`, [l.bin_id, l.counted]);
    } else if (l.location_id !== null || l.lot) {
      // A place found during the count (or one emptied since it started).
      if (l.counted > 0) await client.query(`INSERT INTO stock_bins (serial_number, location_id, lot, date_code, qty, source) VALUES ($1, $2, $3, $4, $5, $6)`,
        [l.serial_number, l.location_id, l.lot, l.date_code, l.counted, ref]);
    } // else: stock with no location, which is the stock less the places: changed through stock below.
    await client.query(`INSERT INTO stock_bin_moves (serial_number, bin_id, location_id, lot, qty, reason, reference, by_user) VALUES ($1, $2, $3, $4, $5, 'counted', $6, $7)`,
      [l.serial_number, l.bin_id, l.location_id, l.lot, d, ref, who]);
  }
  const summary: Array<{ serialNumber: string; change: number }> = [];
  for (const [serial, d] of diffs) {
    const { rows: [it] } = await client.query(`UPDATE inventory SET stock = stock + $2 WHERE serial_number = $1 RETURNING name`, [serial, d]);
    await client.query(
      `INSERT INTO transactions (trxId, itemPartNumber, itemName, type, qtyChange, reference, performedBy, dateTime) VALUES ($1, $2, $3, 'STOCK-COUNT', $4, $5, $6, $7)`,
      [`TRX-SC-${count.number}-${serial}`, serial, it?.name ?? serial, d, ref, who, new Date().toISOString()]);
    summary.push({ serialNumber: serial, change: d });
  }
  await client.query(`UPDATE stock_counts SET status = 'POSTED', posted_by = $2, posted_at = now(), summary = $3 WHERE id = $1`,
    [id, who, JSON.stringify({ linesCounted: lines.length, placesChanged, items: summary })]);
  await client.query(
    `INSERT INTO user_activity_logs (user_email, action, entity_type, entity_id, details, status) VALUES ((SELECT email FROM users WHERE email = $1), 'POST_STOCK_COUNT', 'StockCount', $2, $3, 'SUCCESS')`,
    [who, count.number, JSON.stringify({ linesCounted: lines.length, items: summary, by: who })]);
  return { number: count.number as string, linesCounted: lines.length, placesChanged, items: summary };
}

export function registerStockCountsRoutes(app: Express): void {
  app.get('/api/stock-counts', async (_req, res) => {
    try {
      const { rows } = await query(`SELECT c.*, l.code AS location_code,
          (SELECT COUNT(*)::int FROM stock_count_lines x WHERE x.count_id = c.id) AS lines,
          (SELECT COUNT(*)::int FROM stock_count_lines x WHERE x.count_id = c.id AND x.counted IS NOT NULL) AS counted
        FROM stock_counts c LEFT JOIN stock_locations l ON l.id = c.location_id ORDER BY c.id DESC LIMIT 200`);
      res.json(rows);
    } catch (err) { httpError(res, err); }
  });

  app.get('/api/stock-counts/:id', async (req, res) => {
    try {
      const c = await loadCount({ query: (s, p) => query(s, p) }, parseInt(req.params.id));
      if (!c) return res.status(404).json({ error: 'Count not found.' });
      res.json(c);
    } catch (err) { httpError(res, err); }
  });

  app.post('/api/stock-counts', requirePermission('inventory.update'), async (req: any, res) => {
    const b = req.body ?? {};
    const scope = ['location', 'unplaced', 'all'].includes(b.scope) ? b.scope : null;
    if (!scope) return res.status(400).json({ error: 'Count one location, the stock with no location, or everything.' });
    const locationId = scope === 'location' ? Number(b.locationId) : null;
    if (scope === 'location' && !(locationId! > 0)) return res.status(400).json({ error: 'Choose the location to count.' });
    const prefix = String(b.prefix ?? '').trim().toUpperCase() || null;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { id: countId, number } = await createCount(client, { scope, locationId, prefix, notes: String(b.notes ?? '').trim() || null, by: req.user?.email ?? null });
      await client.query('COMMIT');
      res.status(201).json({ id: countId, number });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      httpError(res, err);
    } finally { client.release(); }
  });

  app.put('/api/stock-counts/:id/lines', requirePermission('inventory.update'), async (req, res) => {
    const id = parseInt(req.params.id);
    const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];
    try {
      const { rows: [c] } = await query(`SELECT status FROM stock_counts WHERE id = $1`, [id]);
      if (!c) return res.status(404).json({ error: 'Count not found.' });
      if (c.status !== 'OPEN') return res.status(409).json({ error: `This count is ${c.status.toLowerCase()}.` });
      for (const l of lines) {
        const counted = l.counted === null || l.counted === '' || l.counted === undefined ? null : Math.floor(Number(l.counted));
        if (counted !== null && !(counted >= 0)) return res.status(400).json({ error: 'A count is a whole number of 0 or more.' });
        await query(`UPDATE stock_count_lines SET counted = $3, note = COALESCE($4, note) WHERE id = $2 AND count_id = $1`,
          [id, Number(l.id), counted, l.note === undefined ? null : String(l.note).trim() || null]);
      }
      res.json({ saved: lines.length });
    } catch (err) { httpError(res, err); }
  });

  app.post('/api/stock-counts/:id/lines', requirePermission('inventory.update'), async (req, res) => {
    const id = parseInt(req.params.id);
    const serial = String(req.body?.serialNumber ?? '').trim();
    try {
      const { rows: [c] } = await query(`SELECT status, location_id FROM stock_counts WHERE id = $1`, [id]);
      if (!c) return res.status(404).json({ error: 'Count not found.' });
      if (c.status !== 'OPEN') return res.status(409).json({ error: `This count is ${c.status.toLowerCase()}.` });
      const { rows: [item] } = await query(`SELECT serial_number FROM inventory WHERE serial_number = $1 AND deleted IS NOT TRUE`, [serial]);
      if (!item) return res.status(400).json({ error: `${serial || 'That item'} isn't in inventory.` });
      const locationId = req.body?.locationId ? Number(req.body.locationId) : c.location_id;
      const lot = String(req.body?.lot ?? '').trim() || null;
      const { rows } = await query(
        `INSERT INTO stock_count_lines (count_id, serial_number, location_id, lot, expected, added) VALUES ($1, $2, $3, $4, 0, true) RETURNING id`,
        [id, serial, locationId, lot]);
      res.status(201).json(rows[0]);
    } catch (err) { httpError(res, err); }
  });

  app.delete('/api/stock-counts/:id', async (req, res) => {
    try {
      const { rows: [c] } = await query(`SELECT status FROM stock_counts WHERE id = $1`, [parseInt(req.params.id)]);
      if (!c) return res.status(404).json({ error: 'Count not found.' });
      if (c.status === 'POSTED') return res.status(409).json({ error: 'A posted count is the record of a stock change, so it stays.' });
      await query(`DELETE FROM stock_counts WHERE id = $1`, [parseInt(req.params.id)]); // its lines go with it
      res.json({ ok: true });
    } catch (err) { httpError(res, err); }
  });

  app.post('/api/stock-counts/:id/cancel', requirePermission('inventory.update'), async (req, res) => {
    try {
      const { rowCount } = await query(`UPDATE stock_counts SET status = 'CANCELLED' WHERE id = $1 AND status = 'OPEN'`, [parseInt(req.params.id)]);
      if (!rowCount) return res.status(409).json({ error: 'Only an open count can be cancelled.' });
      res.json({ ok: true });
    } catch (err) { httpError(res, err); }
  });

  app.post('/api/stock-counts/:id/post', requirePermission('inventory.update'), async (req: any, res) => {
    const id = parseInt(req.params.id);
    const who = req.user?.email ?? 'unknown';
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await postCount(client, id, who);
      await client.query('COMMIT');
      res.json(result);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      httpError(res, err);
    } finally { client.release(); }
  });
}
