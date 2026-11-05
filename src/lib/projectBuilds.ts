// Project Processing: a build of a project from start to finish.
//
//   1. Book out the kit      Kit Booking's book-out with {buildId}: what it
//                            takes is recorded against the build (build_issues)
//   2. Book in what's built  each unit gets a serial from its product's format
//                            (TCU06-POP-0001) and the build a batch code
//                            (TCU06-POP-B001); a unit is booked in by scanning
//                            its label, or all at once. Built stock is the
//                            Production Costs product's code, made a stock item
//                            the first time.
//   3. Count what's left     of each part sent, what came back goes to stock:
//                            to the part itself, or to a packet item (packaging
//                            X1 PACKET, a code of its own, e.g. CAP-024-PKT)
//                            for the loose parts off a reel; a packet that
//                            exists is added to
//   4. Complete              built, scrapped, notes; the build is closed
//
// Tables: builds, build_issues, build_units, build_returns, packet_items.
// Writes need inventory.update (./writeAccess, area "builds").

import type { Express } from 'express';
import { pool, query, queryOne, exec } from './db';
import { nextDocNumber } from './bookkeeping-db';

type Db = { query: (s: string, p?: any[]) => Promise<any> };

export async function ensureProjectBuildsSchema(run: (sql: string) => Promise<void> = exec): Promise<void> {
  await run(`ALTER TABLE production_products ADD COLUMN IF NOT EXISTS unit_format TEXT`);
  await run(`ALTER TABLE production_products ADD COLUMN IF NOT EXISTS batch_format TEXT`);
  await run(`CREATE SEQUENCE IF NOT EXISTS build_seq START 1`);
  await run(`CREATE TABLE IF NOT EXISTS builds (
    id SERIAL PRIMARY KEY,
    number TEXT UNIQUE NOT NULL,
    project_id TEXT NOT NULL,
    model_number TEXT NOT NULL,
    qty_planned INTEGER NOT NULL CHECK (qty_planned > 0),
    status TEXT NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED', 'BOOKED_OUT', 'BUILDING', 'COMPLETE', 'CANCELLED')),
    batch_code TEXT,
    qty_built INTEGER NOT NULL DEFAULT 0,
    qty_scrapped INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    completion_notes TEXT,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    booked_out_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    completed_by TEXT
  )`);
  await run(`CREATE TABLE IF NOT EXISTS build_issues (
    id SERIAL PRIMARY KEY,
    build_id INTEGER NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
    serial_number TEXT NOT NULL,
    qty INTEGER NOT NULL,
    for_line TEXT,
    at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await run(`CREATE TABLE IF NOT EXISTS build_units (
    serial TEXT PRIMARY KEY,
    build_id INTEGER NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
    model_number TEXT NOT NULL,
    batch_code TEXT,
    status TEXT NOT NULL DEFAULT 'LABELLED' CHECK (status IN ('LABELLED', 'IN_STOCK', 'SCRAPPED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    booked_in_at TIMESTAMPTZ,
    booked_in_by TEXT
  )`);
  await run(`CREATE INDEX IF NOT EXISTS build_units_build ON build_units (build_id)`);
  await run(`CREATE TABLE IF NOT EXISTS build_returns (
    id SERIAL PRIMARY KEY,
    build_id INTEGER NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
    serial_number TEXT NOT NULL,
    booked_out INTEGER NOT NULL,
    counted INTEGER NOT NULL CHECK (counted >= 0),
    to_code TEXT NOT NULL,
    at TIMESTAMPTZ NOT NULL DEFAULT now(),
    by_user TEXT
  )`);
  await run(`CREATE TABLE IF NOT EXISTS packet_items (
    packet_code TEXT PRIMARY KEY REFERENCES inventory(serial_number) ON UPDATE CASCADE ON DELETE CASCADE,
    reel_code TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await run(`CREATE INDEX IF NOT EXISTS packet_items_reel ON packet_items (reel_code)`);
}

// ---------------------------------------------------------------------------
// The rules, without a database.

export const DEFAULT_UNIT_FORMAT = '{MODEL}-{0000}';
export const DEFAULT_BATCH_FORMAT = '{MODEL}-B{000}';
export const PACKET_PACKAGING = 'X1 PACKET';

/**
 * A serial or batch code from a format: {MODEL} the product code, {YYYY} the
 * year, {0000} the running number with as many digits as zeros (TCU06-POP-{0000}).
 */
export function formatCode(format: string, model: string, n: number, year = new Date().getFullYear()): string {
  return String(format || DEFAULT_UNIT_FORMAT)
    .replace(/\{MODEL\}/gi, model)
    .replace(/\{YYYY\}/gi, String(year))
    .replace(/\{(0+)\}/, (_, z: string) => String(n).padStart(z.length, '0'));
}

/** Whether a format has a running number (otherwise every unit would get the same serial). */
export const hasCounter = (format: string) => /\{0+\}/.test(String(format ?? ''));

/** The running number a code made from a format holds, or null if it wasn't made from it. */
export function counterOf(format: string, model: string, code: string, year = new Date().getFullYear()): number | null {
  const f = String(format || DEFAULT_UNIT_FORMAT).replace(/\{MODEL\}/gi, model).replace(/\{YYYY\}/gi, String(year));
  const m = f.match(/\{(0+)\}/);
  if (!m) return null;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const [before, after] = [f.slice(0, m.index), f.slice((m.index ?? 0) + m[0].length)];
  const got = String(code).match(new RegExp(`^${esc(before)}(\\d{${m[1].length},})${esc(after)}$`, 'i'));
  return got ? Number(got[1]) : null;
}

/** The next `count` codes after the highest already used. */
export function nextCodes(format: string, model: string, used: string[], count: number, year = new Date().getFullYear()): string[] {
  const top = used.reduce((max, c) => Math.max(max, counterOf(format, model, c, year) ?? 0), 0);
  return Array.from({ length: count }, (_, i) => formatCode(format, model, top + i + 1, year));
}

/** A packet item's code for a part: its code and -PKT, unless one is given. */
export const packetCodeFor = (code: string, given?: string | null) => (String(given ?? '').trim() || `${code}-PKT`).toUpperCase().replace(/\s+/g, '-');

export interface IssueLine { serial_number: string; booked_out: number }
export interface CountLine { serial_number: string; counted: number }

/** What a build used of each part: booked out less counted back (never below 0), and the lines counted back above what was sent. */
export function usage(issues: IssueLine[], counts: CountLine[]) {
  const back = new Map<string, number>();
  for (const c of counts) back.set(c.serial_number, (back.get(c.serial_number) ?? 0) + (Number(c.counted) || 0));
  return issues.map((i) => {
    const returned = back.get(i.serial_number) ?? 0;
    return { serial_number: i.serial_number, bookedOut: i.booked_out, returned, used: Math.max(0, i.booked_out - returned), over: Math.max(0, returned - i.booked_out) };
  });
}

// ---------------------------------------------------------------------------

const httpError = (res: any, err: any) => res.status(err.status || 500).json({ error: err.message });
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const text = (v: unknown, max = 2000) => { const t = String(v ?? '').trim(); return t ? t.slice(0, max) : null; };

async function productOf(db: Db, model: string) {
  const { rows: [p] } = await db.query(`SELECT model_number, description, category, production_cost, currency, unit_format, batch_format FROM production_products WHERE UPPER(model_number) = UPPER($1)`, [model]);
  return p ?? null;
}

async function loadBuild(db: Db, id: number, lock = false) {
  const { rows: [b] } = await db.query(`SELECT * FROM builds WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!b) throw fail(404, 'Build not found.');
  return b;
}

/** Makes the product a stock item the first time it is built: its description, costed at its production cost in USD. */
async function ensureProductItem(db: Db, p: any) {
  const { rows: [have] } = await db.query(`SELECT serial_number FROM inventory WHERE UPPER(serial_number) = UPPER($1)`, [p.model_number]);
  if (have) {
    await db.query(`UPDATE inventory SET deleted = false WHERE serial_number = $1 AND deleted IS TRUE`, [have.serial_number]);
    return have.serial_number as string;
  }
  const { rows: [rate] } = await db.query(`SELECT value FROM settings WHERE key = 'usd_to_zar_rate'`).catch(() => ({ rows: [] }));
  const zar = Number(p.production_cost) || 0;
  const usd = String(p.currency ?? 'ZAR').toUpperCase() === 'USD' ? zar : rate?.value ? zar / Number(rate.value) : 0;
  await db.query(`INSERT INTO inventory (serial_number, name, description, stock, current_cost_dollar, status, type, project) VALUES ($1, $2, $3, 0, $4, 'ACTIVE', $5, $6)`,
    [p.model_number, p.description ?? p.model_number, p.description ?? null, Math.round(usd * 10000) / 10000, 'Built product', p.category ?? null]);
  return p.model_number as string;
}

async function stockMove(db: Db, code: string, qty: number, type: string, reference: string, who: string) {
  const { rows: [item] } = await db.query(`UPDATE inventory SET stock = COALESCE(stock, 0) + $2 WHERE serial_number = $1 RETURNING name`, [code, qty]);
  await db.query(`INSERT INTO transactions (trxId, itemPartNumber, itemName, type, qtyChange, reference, performedBy, dateTime) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [`TRX-BLD-${code}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, code, item?.name ?? code, type, qty, reference, who, new Date().toISOString()]);
}

/** A part's packet item: the given code, else its existing packet, else a new one copied from the part (packaging X1 PACKET). */
export async function packetFor(db: Db, code: string, given?: string | null): Promise<string> {
  const wanted = text(given, 60);
  if (!wanted) {
    const { rows: [known] } = await db.query(`SELECT p.packet_code FROM packet_items p JOIN inventory i ON i.serial_number = p.packet_code AND i.deleted IS NOT TRUE WHERE p.reel_code = $1 ORDER BY p.created_at LIMIT 1`, [code]);
    if (known) return known.packet_code;
  }
  const packet = packetCodeFor(code, wanted);
  if (packet === code.toUpperCase()) throw fail(400, `The packet needs a code of its own, not ${code}.`);
  const { rows: [exists] } = await db.query(`SELECT serial_number FROM inventory WHERE UPPER(serial_number) = $1`, [packet]);
  if (exists) {
    await db.query(`UPDATE inventory SET deleted = false WHERE serial_number = $1 AND deleted IS TRUE`, [exists.serial_number]);
    await db.query(`INSERT INTO packet_items (packet_code, reel_code) VALUES ($1, $2) ON CONFLICT (packet_code) DO NOTHING`, [exists.serial_number, code]);
    return exists.serial_number;
  }
  // A copy of the part (its name, footprint, part numbers, cost …) as a packet.
  const { rows: cols } = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'inventory' AND column_name NOT IN ('serial_number', 'stock', 'packaging', 'deleted')`);
  const list = cols.map((c: any) => `"${c.column_name}"`).join(', ');
  const { rowCount } = await db.query(`INSERT INTO inventory (serial_number, stock, packaging, deleted, ${list}) SELECT $2, 0, $3, false, ${list} FROM inventory WHERE serial_number = $1`, [code, packet, PACKET_PACKAGING]);
  if (!rowCount) throw fail(400, `${code} isn't in inventory.`);
  await db.query(`INSERT INTO packet_items (packet_code, reel_code) VALUES ($1, $2)`, [packet, code]);
  return packet;
}

/** Books in built units: the serials given (labelled already, e.g. scanned), or `count` new ones. */
async function bookIn(client: Db, b: any, who: string, opts: { serials?: string[]; count?: number }) {
  const p = await productOf(client, b.model_number);
  if (!p) throw fail(400, `${b.model_number} isn't in Production Costs any more.`);
  let serials: string[] = [];
  if (opts.serials?.length) {
    const { rows } = await client.query(`SELECT serial, status, build_id FROM build_units WHERE UPPER(serial) = ANY($1::text[]) FOR UPDATE`, [opts.serials.map((s) => s.toUpperCase())]);
    for (const s of opts.serials) {
      const u = rows.find((r: any) => r.serial.toUpperCase() === s.toUpperCase());
      if (!u) throw fail(400, `${s} isn't a label of any build.`);
      if (u.build_id !== b.id) throw fail(400, `${u.serial} belongs to another build.`);
      if (u.status === 'IN_STOCK') throw fail(409, `${u.serial} is already booked in.`);
      if (u.status === 'SCRAPPED') throw fail(409, `${u.serial} was scrapped.`);
      serials.push(u.serial);
    }
  } else {
    const n = Math.floor(Number(opts.count));
    if (!(n > 0)) throw fail(400, 'Book in a whole number of 1 or more.');
    // Labels printed and not booked in yet go first, then new serials.
    const { rows: waiting } = await client.query(`SELECT serial FROM build_units WHERE build_id = $1 AND status = 'LABELLED' ORDER BY serial LIMIT $2 FOR UPDATE`, [b.id, n]);
    serials = waiting.map((r: any) => r.serial);
    if (serials.length < n) serials.push(...(await makeUnits(client, b, p, n - serials.length)));
  }
  const code = await ensureProductItem(client, p);
  await client.query(`UPDATE build_units SET status = 'IN_STOCK', booked_in_at = now(), booked_in_by = $2 WHERE serial = ANY($1::text[])`, [serials, who]);
  await stockMove(client, code, serials.length, 'BOOK-IN', `Build ${b.number} (${b.batch_code})${serials.length <= 5 ? `: ${serials.join(', ')}` : `: ${serials[0]} … ${serials[serials.length - 1]}`}`, who);
  await client.query(`UPDATE builds SET qty_built = qty_built + $2, status = CASE WHEN status IN ('PLANNED', 'BOOKED_OUT') THEN 'BUILDING' ELSE status END WHERE id = $1`, [b.id, serials.length]);
  return { code, serials };
}

/** New unit serials for a build (labelled, not booked in), and its batch code if it has none. */
async function makeUnits(client: Db, b: any, p: any, count: number): Promise<string[]> {
  const unitFormat = p.unit_format || DEFAULT_UNIT_FORMAT;
  // One numbering per product at a time.
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('build-units'), hashtext($1))`, [p.model_number]);
  const { rows: used } = await client.query(`SELECT serial FROM build_units WHERE model_number = $1`, [p.model_number]);
  const serials = nextCodes(unitFormat, p.model_number, used.map((r: any) => r.serial), count);
  const { rows: clash } = await client.query(`SELECT serial FROM build_units WHERE UPPER(serial) = ANY($1::text[])`, [serials.map((s) => s.toUpperCase())]);
  if (clash.length) throw fail(409, `${clash[0].serial} is already used: change the product's serial format.`);
  for (const s of serials) await client.query(`INSERT INTO build_units (serial, build_id, model_number, batch_code) VALUES ($1, $2, $3, $4)`, [s, b.id, p.model_number, b.batch_code]);
  return serials;
}

async function ensureBatch(client: Db, b: any, p: any) {
  if (b.batch_code) return b.batch_code;
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('build-batch'), hashtext($1))`, [p.model_number]);
  const { rows: used } = await client.query(`SELECT batch_code FROM builds WHERE model_number = $1 AND batch_code IS NOT NULL`, [p.model_number]);
  const [code] = nextCodes(p.batch_format || DEFAULT_BATCH_FORMAT, p.model_number, used.map((r: any) => r.batch_code), 1);
  await client.query(`UPDATE builds SET batch_code = $2 WHERE id = $1`, [b.id, code]);
  b.batch_code = code;
  return code;
}

async function withTx<T>(fn: (client: any) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

export async function buildDetail(db: Db, id: number) {
  const b = await loadBuild(db, id);
  const { rows: [project] } = await db.query(`SELECT id, project_name FROM projects WHERE id::text = $1`, [b.project_id]);
  const p = await productOf(db, b.model_number);
  const { rows: issues } = await db.query(`SELECT bi.serial_number, SUM(bi.qty)::int AS booked_out, MAX(i.name) AS name, MAX(i.packaging) AS packaging, MAX(i.stock) AS stock,
      (SELECT p.packet_code FROM packet_items p WHERE p.reel_code = bi.serial_number ORDER BY p.created_at LIMIT 1) AS packet_code
    FROM build_issues bi LEFT JOIN inventory i ON i.serial_number = bi.serial_number WHERE bi.build_id = $1 GROUP BY bi.serial_number ORDER BY bi.serial_number`, [id]);
  const { rows: returns } = await db.query(`SELECT serial_number, booked_out, counted, to_code, at, by_user FROM build_returns WHERE build_id = $1 ORDER BY id`, [id]);
  const { rows: units } = await db.query(`SELECT serial, status, batch_code, booked_in_at, booked_in_by FROM build_units WHERE build_id = $1 ORDER BY serial`, [id]);
  return {
    build: { ...b, project_name: project?.project_name ?? null },
    product: p ? { ...p, unit_format: p.unit_format || DEFAULT_UNIT_FORMAT, batch_format: p.batch_format || DEFAULT_BATCH_FORMAT } : null,
    issues, returns, units,
    usage: usage(issues.map((i: any) => ({ serial_number: i.serial_number, booked_out: i.booked_out })), returns.map((r: any) => ({ serial_number: r.serial_number, counted: r.counted }))),
  };
}

export function registerProjectBuildRoutes(app: Express): void {
  app.get('/api/builds', async (req, res) => {
    const open = req.query.open === '1';
    try {
      const { rows } = await query(`SELECT b.*, pr.project_name, pp.description AS product_description,
          (SELECT COALESCE(SUM(qty), 0)::int FROM build_issues WHERE build_id = b.id) AS parts_out,
          (SELECT COUNT(*)::int FROM build_returns WHERE build_id = b.id) AS counted_lines
        FROM builds b LEFT JOIN projects pr ON pr.id::text = b.project_id LEFT JOIN production_products pp ON pp.model_number = b.model_number
        ${open ? `WHERE b.status NOT IN ('COMPLETE', 'CANCELLED')` : ''} ORDER BY (b.status IN ('COMPLETE', 'CANCELLED')), b.id DESC LIMIT 300`);
      res.json(rows);
    } catch (err) { httpError(res, err); }
  });

  // What a new build can be: the projects, and the products (the ones each project is a board of first).
  app.get('/api/builds/options', async (_req, res) => {
    try {
      const { rows: projects } = await query(`SELECT id, project_name, status FROM projects ORDER BY (LOWER(COALESCE(status, '')) = 'inactive'), project_name`);
      const { rows: products } = await query(`SELECT model_number, description, category, production_cost, currency, COALESCE(unit_format, $1) AS unit_format, COALESCE(batch_format, $2) AS batch_format FROM production_products ORDER BY model_number`, [DEFAULT_UNIT_FORMAT, DEFAULT_BATCH_FORMAT]);
      const { rows: boards } = await query(`SELECT model_number, project_id::text AS project_id FROM product_boards`).catch(() => ({ rows: [] as any[] }));
      res.json({ projects, products, boards });
    } catch (err) { httpError(res, err); }
  });

  app.put('/api/builds/product-format', async (req, res) => {
    const unit = text(req.body?.unitFormat, 60); const batch = text(req.body?.batchFormat, 60);
    if (unit && !hasCounter(unit)) return res.status(400).json({ error: 'The serial format needs a running number, such as {0000}.' });
    if (batch && !hasCounter(batch)) return res.status(400).json({ error: 'The batch format needs a running number, such as {000}.' });
    try {
      const row = await queryOne(`UPDATE production_products SET unit_format = $2, batch_format = $3, updated_at = now() WHERE UPPER(model_number) = UPPER($1) RETURNING model_number, unit_format, batch_format`,
        [String(req.body?.modelNumber ?? ''), unit, batch]);
      if (!row) return res.status(404).json({ error: 'Product not found.' });
      res.json(row);
    } catch (err) { httpError(res, err); }
  });

  app.post('/api/builds', async (req: any, res) => {
    const b = req.body ?? {};
    const qty = Math.floor(Number(b.qty));
    if (!(qty > 0)) return res.status(400).json({ error: 'Build a whole number of 1 or more.' });
    try {
      const out = await withTx(async (client) => {
        const { rows: [project] } = await client.query(`SELECT id FROM projects WHERE id::text = $1`, [String(b.projectId ?? '')]);
        if (!project) throw fail(400, 'Choose the project.');
        const p = await productOf(client, String(b.modelNumber ?? ''));
        if (!p) throw fail(400, 'Choose what it builds, from Production Costs.');
        const number = await nextDocNumber(client, 'BLD', 'build_seq');
        const { rows: [row] } = await client.query(`INSERT INTO builds (number, project_id, model_number, qty_planned, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [number, String(project.id), p.model_number, qty, text(b.notes), req.user?.email ?? null]);
        await ensureBatch(client, row, p);
        return row;
      });
      res.status(201).json(out);
    } catch (err) { httpError(res, err); }
  });

  app.get('/api/builds/:id', async (req, res) => {
    try { res.json(await buildDetail({ query: (s, p) => query(s, p) }, parseInt(req.params.id))); } catch (err) { httpError(res, err); }
  });

  // Labels for units not built yet: {count} new serials, ready to stick on and scan when each is done.
  app.post('/api/builds/:id/labels', async (req: any, res) => {
    const count = Math.floor(Number(req.body?.count));
    if (!(count > 0 && count <= 1000)) return res.status(400).json({ error: 'Make labels for 1 to 1,000 units.' });
    try {
      const out = await withTx(async (client) => {
        const b = await loadBuild(client, parseInt(req.params.id), true);
        if (b.status === 'COMPLETE' || b.status === 'CANCELLED') throw fail(409, `This build is ${b.status.toLowerCase()}.`);
        const p = await productOf(client, b.model_number);
        await ensureBatch(client, b, p);
        return { batch: b.batch_code, serials: await makeUnits(client, b, p, count) };
      });
      res.json(out);
    } catch (err) { httpError(res, err); }
  });

  // Book in built units: {serials} (scanned labels) or {count}.
  app.post('/api/builds/:id/book-in', async (req: any, res) => {
    const serials: string[] = Array.isArray(req.body?.serials) ? req.body.serials.map((s: unknown) => String(s).trim()).filter(Boolean) : [];
    try {
      const out = await withTx(async (client) => {
        const b = await loadBuild(client, parseInt(req.params.id), true);
        if (b.status === 'COMPLETE' || b.status === 'CANCELLED') throw fail(409, `This build is ${b.status.toLowerCase()}.`);
        const p = await productOf(client, b.model_number);
        await ensureBatch(client, b, p);
        return bookIn(client, b, req.user?.email ?? 'unknown', serials.length ? { serials } : { count: req.body?.count });
      });
      res.json(out);
    } catch (err) { httpError(res, err); }
  });

  // The count of what's left of each part sent: {lines: [{serialNumber, counted, toPacket?, packetCode?}]}.
  app.post('/api/builds/:id/returns', async (req: any, res) => {
    const lines: any[] = Array.isArray(req.body?.lines) ? req.body.lines : [];
    if (!lines.length) return res.status(400).json({ error: 'Nothing counted.' });
    const who = req.user?.email ?? 'unknown';
    try {
      const out = await withTx(async (client) => {
        const b = await loadBuild(client, parseInt(req.params.id), true);
        if (b.status === 'PLANNED' || b.status === 'CANCELLED') throw fail(409, b.status === 'PLANNED' ? 'Nothing has been booked out for this build yet.' : 'This build is cancelled.');
        const { rows: issues } = await client.query(`SELECT serial_number, SUM(qty)::int AS booked_out FROM build_issues WHERE build_id = $1 GROUP BY 1`, [b.id]);
        const sent = new Map(issues.map((i: any) => [i.serial_number, i.booked_out]));
        const done: any[] = [];
        for (const l of lines) {
          const code = String(l.serialNumber ?? '').trim();
          const counted = Math.floor(Number(l.counted));
          if (!sent.has(code)) throw fail(400, `${code || 'That part'} wasn't booked out for this build.`);
          if (!(counted >= 0)) throw fail(400, `${code}: the count is a whole number of 0 or more.`);
          const to = l.toPacket ? await packetFor(client, code, l.packetCode) : code;
          if (counted > 0) await stockMove(client, to, counted, 'RETURN', `Build ${b.number}: left over${to !== code ? ` from ${code}, as a packet` : ''}`, who);
          await client.query(`INSERT INTO build_returns (build_id, serial_number, booked_out, counted, to_code, by_user) VALUES ($1, $2, $3, $4, $5, $6)`, [b.id, code, sent.get(code), counted, to, who]);
          done.push({ serialNumber: code, counted, to });
        }
        return { returned: done };
      });
      res.json(out);
    } catch (err) { httpError(res, err); }
  });

  // Close the build: {scrapped, notes}. Labels never booked in are marked scrapped with it.
  app.post('/api/builds/:id/complete', async (req: any, res) => {
    const scrapped = Math.floor(Number(req.body?.scrapped ?? 0));
    if (!(scrapped >= 0)) return res.status(400).json({ error: 'Scrapped is a whole number of 0 or more.' });
    try {
      const out = await withTx(async (client) => {
        const b = await loadBuild(client, parseInt(req.params.id), true);
        if (b.status === 'COMPLETE' || b.status === 'CANCELLED') throw fail(409, `This build is already ${b.status.toLowerCase()}.`);
        if (b.status === 'PLANNED') throw fail(409, 'Book the kit out first, or cancel the build.');
        const { rows: [left] } = await client.query(`SELECT COUNT(*)::int n FROM build_units WHERE build_id = $1 AND status = 'LABELLED'`, [b.id]);
        if (left.n && !req.body?.scrapUnbooked) throw fail(409, `${left.n} labelled unit${left.n === 1 ? ' hasn\'t' : 's haven\'t'} been booked in. Book ${left.n === 1 ? 'it' : 'them'} in, or say ${left.n === 1 ? 'it was' : 'they were'} scrapped.`);
        await client.query(`UPDATE build_units SET status = 'SCRAPPED' WHERE build_id = $1 AND status = 'LABELLED'`, [b.id]);
        const { rows: [row] } = await client.query(`UPDATE builds SET status = 'COMPLETE', qty_scrapped = $2, completion_notes = $3, completed_at = now(), completed_by = $4 WHERE id = $1 RETURNING *`,
          [b.id, scrapped + (left.n || 0), text(req.body?.notes), req.user?.email ?? null]);
        return row;
      });
      res.json(out);
    } catch (err) { httpError(res, err); }
  });

  app.post('/api/builds/:id/cancel', async (req, res) => {
    try {
      const row = await queryOne(`UPDATE builds SET status = 'CANCELLED' WHERE id = $1 AND status = 'PLANNED' RETURNING *`, [parseInt(req.params.id)]);
      if (!row) return res.status(409).json({ error: 'Only a build with nothing booked out can be cancelled.' });
      res.json(row);
    } catch (err) { httpError(res, err); }
  });

  // A scanned unit label: which build it is, so the scan screen can book it in.
  app.get('/api/builds/unit/:serial', async (req, res) => {
    try {
      const row = await queryOne(`SELECT u.*, b.number, b.status AS build_status FROM build_units u JOIN builds b ON b.id = u.build_id WHERE UPPER(u.serial) = UPPER($1)`, [req.params.serial]);
      if (!row) return res.status(404).json({ error: `${req.params.serial} isn't a unit label.` });
      res.json(row);
    } catch (err) { httpError(res, err); }
  });
}

/**
 * For Kit Booking's book-out with {buildId}, in its transaction: the build
 * must be this project's and not booked out yet; what is taken is recorded.
 */
export async function checkBuildForBookOut(client: Db, buildId: number, projectId: unknown, buildQty: unknown) {
  const b = await loadBuild(client, buildId, true);
  if (String(b.project_id) !== String(projectId)) throw fail(400, `Build ${b.number} is for another project.`);
  if (b.status !== 'PLANNED') throw fail(409, `Build ${b.number} has already been booked out.`);
  if (Number(buildQty) !== Number(b.qty_planned)) throw fail(400, `Build ${b.number} is for ${b.qty_planned}; book out ${b.qty_planned}.`);
  return b;
}

export async function recordBuildBookOut(client: Db, build: any, deductions: Array<{ code: string; qty: number; forLine: string }>) {
  for (const d of deductions) await client.query(`INSERT INTO build_issues (build_id, serial_number, qty, for_line) VALUES ($1, $2, $3, $4)`, [build.id, d.code, d.qty, d.forLine]);
  await client.query(`UPDATE builds SET status = 'BOOKED_OUT', booked_out_at = now() WHERE id = $1`, [build.id]);
}
