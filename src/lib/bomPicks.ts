// BOM picks: booking a whole BOM out by scanning it.
//
// "Book Out Entire BOM" (BOM Manager) starts a pick instead of booking out
// at once. The phone (/scan > Scan BOM items) sees every open pick, shows
// where each item is kept, and each reel scanned is recorded against its
// line; a line goes green on both the phone and the desktop once what was
// scanned covers what it needs. An item kept on reels is taken a whole reel
// (everything in the place scanned) at a time; anything else must match
// what the line still needs. When every line is green, the desktop shows a
// final check, and approving it books out exactly what was scanned, from
// the places scanned.
//
//   GET  /api/bom-picks?status=OPEN&projectId=   picks, with progress
//   POST /api/bom-picks                {projectId, buildQty, lines: [{bomCode, need, picks?: [{code, qty}]}]}
//                                      -> the pick (409 with {id} when the project already has an open one)
//   GET  /api/bom-picks/:id            the pick: lines (with the item, where it is, what's left in each
//                                      place), scans, whether it is complete
//   PUT  /api/bom-picks/:id/lines      {buildQty?, lines}: the desktop changed its allocation; lines with
//                                      scans are kept as they are
//   POST /api/bom-picks/:id/open       the phone has it open (shown on the desktop as who is scanning)
//   POST /api/bom-picks/:id/scans      {lineId, binId (null: stock with no location), qty?}
//   POST /api/bom-picks/:id/scans/:scanId/undo
//   POST /api/bom-picks/:id/book-out   final check approved: books out what was scanned
//   POST /api/bom-picks/:id/cancel
//
// Writes need inventory.update (writeAccess area "bom-picks").

import type { Express, Response } from 'express';
import { pool, query, exec } from './db';
import { bumpDataVersion } from './dataVersion';

export async function ensureBomPicksSchema(): Promise<void> {
  await exec(`CREATE TABLE IF NOT EXISTS bom_picks (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL,
    project_name TEXT,
    build_qty INTEGER NOT NULL CHECK (build_qty > 0),
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'BOOKED', 'CANCELLED')),
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    picker TEXT,
    picker_seen_at TIMESTAMPTZ,
    decided_by TEXT,
    decided_at TIMESTAMPTZ,
    result JSONB
  )`);
  // One open pick per project at a time.
  await exec(`CREATE UNIQUE INDEX IF NOT EXISTS bom_picks_one_open ON bom_picks (project_id) WHERE status = 'OPEN'`);
  await exec(`CREATE TABLE IF NOT EXISTS bom_pick_lines (
    id SERIAL PRIMARY KEY,
    pick_id INTEGER NOT NULL REFERENCES bom_picks(id) ON DELETE CASCADE,
    bom_code TEXT NOT NULL,
    code TEXT NOT NULL,
    need INTEGER NOT NULL CHECK (need > 0),
    position INTEGER NOT NULL DEFAULT 0
  )`);
  await exec(`CREATE INDEX IF NOT EXISTS bom_pick_lines_pick ON bom_pick_lines (pick_id)`);
  await exec(`CREATE TABLE IF NOT EXISTS bom_pick_scans (
    id SERIAL PRIMARY KEY,
    pick_id INTEGER NOT NULL REFERENCES bom_picks(id) ON DELETE CASCADE,
    line_id INTEGER NOT NULL REFERENCES bom_pick_lines(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    bin_id INTEGER,
    location_code TEXT,
    lot TEXT,
    qty INTEGER NOT NULL CHECK (qty > 0),
    whole_reel BOOLEAN NOT NULL DEFAULT false,
    by_email TEXT,
    by_name TEXT,
    at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await exec(`CREATE INDEX IF NOT EXISTS bom_pick_scans_pick ON bom_pick_scans (pick_id)`);
}

// ---------------------------------------------------------------------------
// The rules, without a database (unit-tested).

const fail = (status: number, message: string, extra: object = {}) => Object.assign(new Error(message), { status, ...extra });
const text = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();

export interface PickLineIn { bomCode: string; code: string; need: number }

/**
 * The lines to scan, from the desktop's BOM audit: each BOM line's picks
 * (the reels allocated to it, its own SKU and alternates), or with none, its
 * own stock code for everything it needs. Lines needing nothing are left out.
 */
export function pickLinesFrom(raw: unknown): PickLineIn[] {
  if (!Array.isArray(raw) || !raw.length) throw fail(400, 'There are no BOM lines to pick.');
  if (raw.length > 2000) throw fail(400, 'That BOM is too long to pick at once.');
  const out = new Map<string, PickLineIn>();
  const add = (bomCode: string, code: string, need: number) => {
    if (!code || !(need > 0)) return;
    const k = `${bomCode.toUpperCase()}|${code.toUpperCase()}`;
    const l = out.get(k);
    if (l) l.need += need; else out.set(k, { bomCode, code, need });
  };
  for (const r of raw as any[]) {
    const bomCode = text(r?.bomCode).slice(0, 80);
    if (!bomCode) continue;
    const picks = Array.isArray(r?.picks) ? r.picks.filter((p: any) => Math.floor(Number(p?.qty)) > 0) : [];
    if (picks.length) for (const p of picks) add(bomCode, text(p.code).slice(0, 80), Math.floor(Number(p.qty)));
    else add(bomCode, bomCode, Math.floor(Number(r?.need)));
  }
  if (!out.size) throw fail(400, 'Every line of this BOM needs nothing: there is nothing to pick.');
  return [...out.values()];
}

/** Kept on reels ("X1 REEL", "2 reels"): taken a whole reel at a time. */
export const isReel = (packaging: unknown) => /\breels?\b/i.test(String(packaging ?? ''));

/**
 * What a scan books against a line. On a reel, the whole reel: everything
 * left in the place scanned. Otherwise the quantity asked for (by default
 * what the line still needs), never more than the line still needs or the
 * place holds.
 */
export function scanQty(o: { reel: boolean; available: number; remaining: number; asked?: number | null }): number {
  if (o.remaining <= 0) throw fail(409, 'This line is already picked.');
  if (o.available <= 0) throw fail(409, 'Nothing is left there to pick: it has been scanned already, or the place is empty.');
  if (o.reel) return o.available;
  const q = o.asked === null || o.asked === undefined || (o.asked as any) === '' ? Math.min(o.remaining, o.available) : Number(o.asked);
  if (!Number.isInteger(q) || q <= 0) throw fail(400, 'Enter a whole quantity of 1 or more.');
  if (q > o.remaining) throw fail(400, `The BOM needs only ${o.remaining} more of this.`);
  if (q > o.available) throw fail(400, `Only ${o.available} there.`);
  return q;
}

export type LineState = 'done' | 'part' | 'todo';
export const lineState = (need: number, picked: number): LineState => (picked >= need ? 'done' : picked > 0 ? 'part' : 'todo');

// ---------------------------------------------------------------------------
// Database work.

type Db = { query: (s: string, p?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }> };
type Who = { email: string; name: string };

async function whoIs(user: { id: number | null; email: string }): Promise<Who> {
  const { rows: [me] } = await query(`SELECT first_name, last_name FROM users WHERE id = $1`, [user.id]);
  return { email: user.email, name: [me?.first_name, me?.last_name].filter(Boolean).join(' ') || user.email };
}

/** A pick as the phone and the desktop see it. */
export async function loadPick(db: Db, id: number) {
  const { rows: [p] } = await db.query(`SELECT * FROM bom_picks WHERE id = $1`, [id]);
  if (!p) return null;
  const { rows: lines } = await db.query(`SELECT * FROM bom_pick_lines WHERE pick_id = $1 ORDER BY position, id`, [id]);
  const { rows: scans } = await db.query(`SELECT * FROM bom_pick_scans WHERE pick_id = $1 ORDER BY at, id`, [id]);
  const codes = [...new Set(lines.map((l: any) => String(l.code).toUpperCase()))];
  const { rows: items } = await db.query(
    `SELECT serial_number, name, description, stock, packaging, man_pn_1 FROM inventory WHERE deleted IS NOT TRUE AND upper(serial_number) = ANY($1::text[])`, [codes]);
  const { rows: bins } = await db.query(
    `SELECT b.id, b.serial_number, b.location_id, b.lot, b.date_code, b.qty, l.code AS location_code, l.name AS location_name
       FROM stock_bins b LEFT JOIN stock_locations l ON l.id = b.location_id
      WHERE upper(b.serial_number) = ANY($1::text[]) AND b.qty > 0 ORDER BY b.received_at, b.id`, [codes]);
  const itemOf = new Map(items.map((i: any) => [String(i.serial_number).toUpperCase(), i]));
  const takenFromBin = new Map<number, number>();
  const takenUnplaced = new Map<string, number>();
  for (const s of scans) {
    if (s.bin_id) takenFromBin.set(s.bin_id, (takenFromBin.get(s.bin_id) ?? 0) + s.qty);
    else takenUnplaced.set(String(s.code).toUpperCase(), (takenUnplaced.get(String(s.code).toUpperCase()) ?? 0) + s.qty);
  }
  const groupSize = new Map<string, number>();
  for (const l of lines) groupSize.set(String(l.bom_code).toUpperCase(), (groupSize.get(String(l.bom_code).toUpperCase()) ?? 0) + 1);
  const out = lines.map((l: any) => {
    const key = String(l.code).toUpperCase();
    const it: any = itemOf.get(key) ?? null;
    const mine = bins.filter((b: any) => String(b.serial_number).toUpperCase() === key);
    const placed = mine.reduce((s: number, b: any) => s + Number(b.qty), 0);
    const places = mine.map((b: any) => ({ binId: b.id as number, locationCode: b.location_code as string | null, locationName: b.location_name as string | null, lot: b.lot as string | null, dateCode: b.date_code as string | null, qty: Number(b.qty), available: Math.max(0, Number(b.qty) - (takenFromBin.get(b.id) ?? 0)) }));
    const unplaced = it ? Math.max(0, Number(it.stock) - placed) : 0;
    if (unplaced > 0) places.push({ binId: null as any, locationCode: null, locationName: null, lot: null, dateCode: null, qty: unplaced, available: Math.max(0, unplaced - (takenUnplaced.get(key) ?? 0)) });
    const lineScans = scans.filter((s: any) => s.line_id === l.id).map((s: any) => ({ id: s.id, binId: s.bin_id, locationCode: s.location_code, lot: s.lot, qty: s.qty, wholeReel: s.whole_reel, by: s.by_name || s.by_email, at: s.at }));
    const picked = lineScans.reduce((s: number, x: any) => s + x.qty, 0);
    return {
      id: l.id as number, bomCode: l.bom_code as string, code: (it?.serial_number ?? l.code) as string, need: l.need as number, picked,
      state: lineState(l.need, picked),
      /** How many items this BOM line is split over (its own SKU and alternates). */
      itemsForBomLine: groupSize.get(String(l.bom_code).toUpperCase()) ?? 1,
      item: it ? { name: it.name || it.serial_number, description: it.description || null, makerPartNumber: it.man_pn_1 || null, stock: Number(it.stock) || 0, packaging: it.packaging || null } : null,
      reel: it ? isReel(it.packaging) : false,
      places,
      scans: lineScans,
    };
  });
  const done = out.filter(l => l.state === 'done').length;
  return {
    id: p.id as number, projectId: p.project_id as number, projectName: p.project_name as string | null, buildQty: p.build_qty as number,
    status: p.status as 'OPEN' | 'BOOKED' | 'CANCELLED', createdBy: p.created_by as string | null, createdAt: p.created_at,
    picker: p.picker as string | null, pickerSeenAt: p.picker_seen_at, decidedBy: p.decided_by as string | null, decidedAt: p.decided_at, result: p.result,
    lines: out, done, total: out.length, complete: out.length > 0 && done === out.length,
  };
}

async function writeLines(client: Db, pickId: number, lines: PickLineIn[]) {
  const { rows: have } = await client.query(
    `SELECT l.id, l.bom_code, l.code, EXISTS (SELECT 1 FROM bom_pick_scans s WHERE s.line_id = l.id) AS scanned FROM bom_pick_lines l WHERE l.pick_id = $1`, [pickId]);
  const key = (b: string, c: string) => `${b.toUpperCase()}|${c.toUpperCase()}`;
  const wanted = new Map(lines.map((l, i) => [key(l.bomCode, l.code), { ...l, position: i }]));
  for (const h of have) {
    const k = key(h.bom_code, h.code);
    const w = wanted.get(k);
    if (h.scanned) { wanted.delete(k); continue; } // scanned lines stay as they are
    if (w) { await client.query(`UPDATE bom_pick_lines SET need = $2, position = $3 WHERE id = $1`, [h.id, w.need, w.position]); wanted.delete(k); }
    else await client.query(`DELETE FROM bom_pick_lines WHERE id = $1`, [h.id]);
  }
  for (const w of wanted.values()) {
    await client.query(`INSERT INTO bom_pick_lines (pick_id, bom_code, code, need, position) VALUES ($1, $2, $3, $4, $5)`, [pickId, w.bomCode, w.code, w.need, w.position]);
  }
}

async function lockOpen(client: Db, id: number) {
  const { rows: [p] } = await client.query(`SELECT * FROM bom_picks WHERE id = $1 FOR UPDATE`, [id]);
  if (!p) throw fail(404, 'That BOM pick no longer exists.');
  if (p.status !== 'OPEN') throw fail(409, p.status === 'BOOKED' ? 'This BOM has been booked out already.' : 'This BOM pick was cancelled.');
  return p;
}

/** Records a scan against a line, in the caller's transaction. */
export async function recordPickScan(client: Db, id: number, b: { lineId: unknown; binId: unknown; qty?: unknown }, who: Who) {
  await lockOpen(client, id);
  const lineId = Number(b.lineId);
  const { rows: [line] } = await client.query(`SELECT * FROM bom_pick_lines WHERE id = $1 AND pick_id = $2`, [lineId, id]);
  if (!line) throw fail(404, 'That line is no longer on this BOM. Reload it.');
  const { rows: [item] } = await client.query(`SELECT serial_number, stock, packaging FROM inventory WHERE upper(serial_number) = upper($1) AND deleted IS NOT TRUE`, [line.code]);
  if (!item) throw fail(400, `${line.code} isn't an item in Tracklab.`);
  const { rows: [{ picked }] } = await client.query(`SELECT COALESCE(SUM(qty), 0)::int AS picked FROM bom_pick_scans WHERE line_id = $1`, [line.id]);
  const binId = b.binId === null || b.binId === undefined || b.binId === '' ? null : Number(b.binId);
  let available: number, locationCode: string | null = null, lot: string | null = null;
  if (binId !== null) {
    const { rows: [bin] } = await client.query(
      `SELECT b.id, b.qty, b.lot, l.code FROM stock_bins b LEFT JOIN stock_locations l ON l.id = b.location_id WHERE b.id = $1 AND b.serial_number = $2`, [binId, item.serial_number]);
    if (!bin) throw fail(409, `That place doesn't hold ${item.serial_number} any more. Reload the BOM.`);
    const { rows: [{ taken }] } = await client.query(`SELECT COALESCE(SUM(qty), 0)::int AS taken FROM bom_pick_scans WHERE pick_id = $1 AND bin_id = $2`, [id, binId]);
    available = Number(bin.qty) - taken; locationCode = bin.code; lot = bin.lot;
  } else {
    const { rows: [{ placed }] } = await client.query(`SELECT COALESCE(SUM(qty), 0)::int AS placed FROM stock_bins WHERE serial_number = $1`, [item.serial_number]);
    const { rows: [{ taken }] } = await client.query(`SELECT COALESCE(SUM(qty), 0)::int AS taken FROM bom_pick_scans WHERE pick_id = $1 AND bin_id IS NULL AND upper(code) = upper($2)`, [id, item.serial_number]);
    available = Math.max(0, Number(item.stock) - placed) - taken;
  }
  const reel = isReel(item.packaging);
  const qty = scanQty({ reel, available, remaining: line.need - picked, asked: b.qty as any });
  await client.query(
    `INSERT INTO bom_pick_scans (pick_id, line_id, code, bin_id, location_code, lot, qty, whole_reel, by_email, by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, line.id, item.serial_number, binId, locationCode, lot, qty, reel, who.email, who.name]);
  await client.query(`UPDATE bom_picks SET picker = $2, picker_seen_at = now() WHERE id = $1`, [id, who.name]);
  return { qty, wholeReel: reel, state: lineState(line.need, picked + qty) };
}

/**
 * The final check approved: books out what was scanned, in the caller's
 * transaction. Each scan comes from the place it was scanned at (refused if
 * that place now holds less); stock with no location from what isn't put
 * away. One BOOK-OUT movement per item and BOM line, as Kit Booking does.
 */
export async function bookOutPick(client: Db, id: number, who: Who) {
  const p = await lockOpen(client, id);
  const view = await loadPick(client, id);
  if (!view!.complete) {
    const left = view!.lines.filter(l => l.state !== 'done').length;
    throw fail(409, `${left} line${left === 1 ? '' : 's'} still to scan.`);
  }
  const { rows: scans } = await client.query(`SELECT s.*, l.bom_code FROM bom_pick_scans s JOIN bom_pick_lines l ON l.id = s.line_id WHERE s.pick_id = $1 ORDER BY s.code, s.id`, [id]);
  const codes = [...new Set(scans.map((s: any) => s.code as string))].sort();
  const { rows: items } = await client.query(`SELECT serial_number, name, stock FROM inventory WHERE serial_number = ANY($1::text[]) ORDER BY serial_number FOR UPDATE`, [codes]);
  const stockOf = new Map(items.map((i: any) => [i.serial_number, { name: i.name, stock: Number(i.stock) || 0 }]));
  const totals = new Map<string, number>();
  for (const s of scans) totals.set(s.code, (totals.get(s.code) ?? 0) + s.qty);
  for (const [code, qty] of totals) {
    const have = stockOf.get(code)?.stock ?? 0;
    if (have < qty) throw fail(409, `${code}: ${qty} scanned but only ${have} in stock now.`);
  }
  const ref = `Kit Booking: Project ${p.project_id} · BOM pick ${id}`;
  for (const s of scans.filter((x: any) => x.bin_id)) {
    const { rows: [bin] } = await client.query(`SELECT id, qty, lot, location_id FROM stock_bins WHERE id = $1 FOR UPDATE`, [s.bin_id]);
    if (!bin || Number(bin.qty) < s.qty) throw fail(409, `${s.code} at ${s.location_code || 'its place'} now holds ${bin ? bin.qty : 0}, less than the ${s.qty} scanned. Undo that scan and scan it again.`);
    if (Number(bin.qty) === s.qty) await client.query(`DELETE FROM stock_bins WHERE id = $1`, [bin.id]);
    else await client.query(`UPDATE stock_bins SET qty = qty - $2 WHERE id = $1`, [bin.id, s.qty]);
    await client.query(`INSERT INTO stock_bin_moves (serial_number, bin_id, location_id, lot, qty, reason, reference, by_user) VALUES ($1, $2, $3, $4, $5, 'used', $6, $7)`,
      [s.code, bin.id, bin.location_id, bin.lot, -s.qty, ref, s.by_email || who.email]);
  }
  const now = new Date().toISOString();
  const byLine = new Map<string, { code: string; bomCode: string; qty: number; by: string }>();
  for (const s of scans) {
    const k = `${s.code}|${s.bom_code}`;
    const e = byLine.get(k) ?? { code: s.code, bomCode: s.bom_code, qty: 0, by: s.by_name || s.by_email };
    e.qty += s.qty; byLine.set(k, e);
  }
  let i = 0;
  for (const e of byLine.values()) {
    await client.query(`UPDATE inventory SET stock = stock - $2 WHERE serial_number = $1`, [e.code, e.qty]);
    await client.query(`INSERT INTO transactions (trxId, itemPartNumber, itemName, type, qtyChange, reference, performedBy, dateTime) VALUES ($1, $2, $3, 'BOOK-OUT', $4, $5, $6, $7)`,
      [`TRX-KIT-${e.code}-${Date.now()}-${i++}`, e.code, stockOf.get(e.code)?.name || e.code, -e.qty, `${ref}${e.bomCode.toUpperCase() !== e.code.toUpperCase() ? ` (for ${e.bomCode})` : ''} (scanned by ${e.by}, approved by ${who.name})`.slice(0, 250), e.by, now]);
  }
  const { rows: [proj] } = await client.query(`SELECT assigned_team FROM projects WHERE id = $1`, [p.project_id]);
  await client.query(`INSERT INTO job_cards (project_id, build_qty, status, created_at, assigned_team) VALUES ($1, $2, 'In Progress', $3, $4)`, [p.project_id, p.build_qty, now, proj?.assigned_team || '']);
  const result = { items: [...totals].map(([code, qty]) => ({ code, qty })), units: [...totals.values()].reduce((a, b) => a + b, 0), scans: scans.length };
  await client.query(`UPDATE bom_picks SET status = 'BOOKED', decided_by = $2, decided_at = now(), result = $3 WHERE id = $1`, [id, who.name, JSON.stringify(result)]);
  await client.query(`INSERT INTO user_activity_logs (user_email, action, entity_type, entity_id, details, status) VALUES ((SELECT email FROM users WHERE email = $1), 'BOOK_OUT_BOM_PICK', 'BomPick', $2, $3, 'SUCCESS')`,
    [who.email, String(id), JSON.stringify({ projectId: p.project_id, buildQty: p.build_qty, ...result, approvedBy: who.email })]);
  return result;
}

// ---------------------------------------------------------------------------
// Routes.

const send = (res: Response, e: any, what: string) => {
  if (e?.status && e.status < 500) return res.status(e.status).json({ error: e.message, ...(e.id ? { id: e.id } : {}) });
  console.error(`[bom-picks] ${what} failed:`, e?.message);
  res.status(500).json({ error: `Could not ${what}. Please try again.` });
};

async function inTx<T>(fn: (c: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client as any);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

const idOf = (v: unknown) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw fail(400, 'That BOM pick is not valid.'); return n; };

export function registerBomPicksRoutes(app: Express): void {
  app.get('/api/bom-picks', async (req, res) => {
    try {
      const status = text(req.query.status).toUpperCase();
      const projectId = Number(req.query.projectId);
      const { rows } = await query(
        `SELECT p.*, (SELECT COUNT(*)::int FROM bom_pick_lines l WHERE l.pick_id = p.id) AS lines,
                (SELECT COUNT(*)::int FROM bom_pick_lines l WHERE l.pick_id = p.id AND (SELECT COALESCE(SUM(s.qty), 0) FROM bom_pick_scans s WHERE s.line_id = l.id) >= l.need) AS done
           FROM bom_picks p
          WHERE ($1 = '' OR p.status = $1) AND ($2::int IS NULL OR p.project_id = $2)
          ORDER BY p.id DESC LIMIT 50`, [['OPEN', 'BOOKED', 'CANCELLED'].includes(status) ? status : '', Number.isInteger(projectId) && projectId > 0 ? projectId : null]);
      res.json({ items: rows.map((r: any) => ({ id: r.id, projectId: r.project_id, projectName: r.project_name, buildQty: r.build_qty, status: r.status, createdBy: r.created_by, createdAt: r.created_at, picker: r.picker, pickerSeenAt: r.picker_seen_at, lines: r.lines, done: r.done })) });
    } catch (e) { send(res, e, 'load the BOM picks'); }
  });

  app.post('/api/bom-picks', async (req: any, res) => {
    try {
      const projectId = Number(req.body?.projectId);
      const buildQty = Number(req.body?.buildQty);
      if (!Number.isInteger(projectId) || projectId <= 0) throw fail(400, 'Choose the project.');
      if (!Number.isInteger(buildQty) || buildQty <= 0) throw fail(400, 'Enter how many boards to build.');
      const lines = pickLinesFrom(req.body?.lines);
      const who = await whoIs(req.user);
      const id = await inTx(async (c) => {
        const { rows: [open] } = await c.query(`SELECT id FROM bom_picks WHERE project_id = $1 AND status = 'OPEN'`, [projectId]);
        if (open) throw fail(409, 'This project already has a BOM pick open.', { id: open.id });
        const { rows: [proj] } = await c.query(`SELECT project_name FROM projects WHERE id = $1`, [projectId]);
        const { rows: [p] } = await c.query(`INSERT INTO bom_picks (project_id, project_name, build_qty, created_by) VALUES ($1, $2, $3, $4) RETURNING id`, [projectId, proj?.project_name ?? null, buildQty, who.name]);
        await writeLines(c, p.id, lines);
        return p.id as number;
      });
      res.status(201).json(await loadPick(pool as any, id));
    } catch (e) { send(res, e, 'start the BOM pick'); }
  });

  app.get('/api/bom-picks/:id', async (req, res) => {
    try {
      const p = await loadPick(pool as any, idOf(req.params.id));
      if (!p) return res.status(404).json({ error: 'That BOM pick no longer exists.' });
      res.json(p);
    } catch (e) { send(res, e, 'load the BOM pick'); }
  });

  app.put('/api/bom-picks/:id/lines', async (req, res) => {
    try {
      const id = idOf(req.params.id);
      const lines = pickLinesFrom(req.body?.lines);
      const buildQty = req.body?.buildQty === undefined ? null : Number(req.body.buildQty);
      if (buildQty !== null && (!Number.isInteger(buildQty) || buildQty <= 0)) throw fail(400, 'Enter how many boards to build.');
      await inTx(async (c) => {
        await lockOpen(c, id);
        if (buildQty !== null) await c.query(`UPDATE bom_picks SET build_qty = $2 WHERE id = $1`, [id, buildQty]);
        await writeLines(c, id, lines);
      });
      res.json(await loadPick(pool as any, id));
    } catch (e) { send(res, e, 'update the BOM pick'); }
  });

  app.post('/api/bom-picks/:id/open', async (req: any, res) => {
    try {
      const id = idOf(req.params.id);
      const who = await whoIs(req.user);
      await query(`UPDATE bom_picks SET picker = $2, picker_seen_at = now() WHERE id = $1 AND status = 'OPEN'`, [id, who.name]);
      const p = await loadPick(pool as any, id);
      if (!p) return res.status(404).json({ error: 'That BOM pick no longer exists.' });
      res.json(p);
    } catch (e) { send(res, e, 'open the BOM pick'); }
  });

  app.post('/api/bom-picks/:id/scans', async (req: any, res) => {
    try {
      const id = idOf(req.params.id);
      const who = await whoIs(req.user);
      const scan = await inTx((c) => recordPickScan(c, id, req.body ?? {}, who));
      res.status(201).json({ scan, pick: await loadPick(pool as any, id) });
    } catch (e) { send(res, e, 'record the scan'); }
  });

  app.post('/api/bom-picks/:id/scans/:scanId/undo', async (req, res) => {
    try {
      const id = idOf(req.params.id);
      await inTx(async (c) => {
        await lockOpen(c, id);
        const r = await c.query(`DELETE FROM bom_pick_scans WHERE id = $1 AND pick_id = $2`, [Number(req.params.scanId), id]);
        if (!r.rowCount) throw fail(404, 'That scan is already undone.');
      });
      res.json(await loadPick(pool as any, id));
    } catch (e) { send(res, e, 'undo the scan'); }
  });

  app.post('/api/bom-picks/:id/book-out', async (req: any, res) => {
    try {
      const id = idOf(req.params.id);
      const who = await whoIs(req.user);
      const result = await inTx((c) => bookOutPick(c, id, who));
      void bumpDataVersion('inventory');
      res.json({ result, pick: await loadPick(pool as any, id) });
    } catch (e) { send(res, e, 'book out the BOM'); }
  });

  app.post('/api/bom-picks/:id/cancel', async (req: any, res) => {
    try {
      const id = idOf(req.params.id);
      const who = await whoIs(req.user);
      const r = await query(`UPDATE bom_picks SET status = 'CANCELLED', decided_by = $2, decided_at = now() WHERE id = $1 AND status = 'OPEN'`, [id, who.name]);
      if (!r.rowCount) return res.status(409).json({ error: 'Only an open BOM pick can be cancelled.' });
      res.json(await loadPick(pool as any, id));
    } catch (e) { send(res, e, 'cancel the BOM pick'); }
  });
}
