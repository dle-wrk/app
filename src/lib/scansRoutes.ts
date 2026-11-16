// Pick scans: photos of picked stock taken with the scanner phone app
// (github.com/ghostsji/scannerapp2), each with its pick note, client, item
// description, quantity, who took it and when. The app signs in with a
// Tracklab account (POST /api/mobile/login, see authRoutes) and sends each
// scan here; the web app shows them under Bookkeeping > Sales > Pick Scans
// and on the sales order / delivery note they belong to.
//
//   POST   /api/scans             multipart: image (file, required), thumbnail (file, optional small JPEG),
//                                 pickNote, description, quantity, clientName?, clientCode?, capturedAt?, clientRef?
//                                 clientRef: an id the phone makes up per scan; resending the same one
//                                 returns the scan already saved, so a retry after a dropped connection
//                                 never makes a duplicate.
//   GET    /api/scans             ?pickNote=&user=&client=&from=&to=&clientOrderId=&dispatchNoteId=&page=&pageSize=
//                                 -> { items, total, page, pageSize }
//   GET    /api/scans/lookup      ?pickNote=  what a pick note number matches (to check typing on the phone)
//   GET    /api/scans/:id         one scan
//   GET    /api/scans/:id/image   the photo (?size=thumb for the small one); needs the session like any /api call
//   DELETE /api/scans/:id         your own scan, or any as an admin
//
// The pick note number is matched (ignoring case and spaces) against sales
// order numbers and delivery / collection note numbers; whichever matches is
// linked, and the client comes from it. With no match the scan is still
// saved, with the number as typed. Saving needs any role but viewer
// (writeAccess 'staff'); everyone signed in can look.

import type { Express, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { pool, query, queryOne, exec } from './db';
import { ensureScanImagesSchema, scanImageStore, sniffImageType, SCAN_IMAGE_MAX_BYTES, SCAN_THUMB_MAX_BYTES } from './scanStorage';

export async function ensureScansSchema(): Promise<void> {
  await ensureScanImagesSchema();
  await exec(`CREATE TABLE IF NOT EXISTS scans (
    id SERIAL PRIMARY KEY,
    client_ref TEXT UNIQUE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    user_email TEXT,
    user_name TEXT,
    pick_note TEXT NOT NULL,
    client_name TEXT,
    client_code TEXT,
    description TEXT NOT NULL,
    quantity NUMERIC(14,3) NOT NULL,
    image_key TEXT NOT NULL,
    thumb_key TEXT,
    client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    client_order_id INTEGER REFERENCES client_orders(id) ON DELETE SET NULL,
    dispatch_note_id INTEGER REFERENCES dispatch_notes(id) ON DELETE SET NULL,
    captured_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await exec(`CREATE INDEX IF NOT EXISTS scans_created_idx ON scans (created_at DESC)`);
  await exec(`CREATE INDEX IF NOT EXISTS scans_pick_note_idx ON scans (lower(pick_note))`);
  await exec(`CREATE INDEX IF NOT EXISTS scans_order_idx ON scans (client_order_id)`);
  await exec(`CREATE INDEX IF NOT EXISTS scans_dispatch_idx ON scans (dispatch_note_id)`);
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested).
// ---------------------------------------------------------------------------

export interface ScanFields {
  pickNote: string;
  clientName: string | null;
  clientCode: string | null;
  description: string;
  quantity: number;
  capturedAt: string | null;
  clientRef: string | null;
}

const bad = (message: string) => Object.assign(new Error(message), { status: 400 });
const text = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();

/** Checks and tidies what the phone sent. Throws an error with status 400 saying what is wrong. */
export function parseScanFields(body: Record<string, unknown>, now = Date.now()): ScanFields {
  const pickNote = text(body.pickNote);
  if (!pickNote) throw bad('Enter the pick note number.');
  if (pickNote.length > 60) throw bad('The pick note number is too long (60 characters at most).');
  const description = text(body.description);
  if (!description) throw bad('Enter the item description or code.');
  if (description.length > 300) throw bad('The description is too long (300 characters at most).');
  const quantity = Number(String(body.quantity ?? '').replace(',', '.').trim());
  if (!Number.isFinite(quantity) || quantity <= 0) throw bad('Enter a quantity above zero.');
  if (quantity > 1_000_000) throw bad('That quantity is too large.');
  const clientName = text(body.clientName).slice(0, 120) || null;
  const clientCode = text(body.clientCode).slice(0, 60) || null;
  // When the photo was taken, for scans that waited in the phone's queue.
  // A missing, unreadable or future time is dropped (the save time is used).
  let capturedAt: string | null = null;
  const t = Date.parse(String(body.capturedAt ?? ''));
  if (Number.isFinite(t) && t <= now + 5 * 60_000 && t > now - 366 * 86_400_000) capturedAt = new Date(t).toISOString();
  const ref = text(body.clientRef);
  if (ref && !/^[A-Za-z0-9._:-]{8,80}$/.test(ref)) throw bad('clientRef must be 8 to 80 letters, digits or . _ : -');
  return { pickNote, clientName, clientCode, description, quantity, capturedAt, clientRef: ref || null };
}

/** How a document number is compared: case and spaces are ignored ("so-2026-0004 " matches "SO-2026-0004"), nothing else. */
export const normaliseNumber = (s: string) => s.toUpperCase().replace(/\s+/g, '');

export function parseListQuery(q: Record<string, unknown>) {
  const page = Math.max(1, Math.floor(Number(q.page)) || 1);
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(q.pageSize)) || 30));
  const day = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : null);
  const id = (v: unknown) => (/^\d+$/.test(String(v ?? '')) ? Number(v) : null);
  return {
    page, pageSize,
    pickNote: text(q.pickNote) || null,
    user: text(q.user) || null,
    client: text(q.client) || null,
    from: day(q.from),
    to: day(q.to),
    clientOrderId: id(q.clientOrderId),
    dispatchNoteId: id(q.dispatchNoteId),
  };
}

const like = (s: string) => `%${s.replace(/[\\%_]/g, '\\$&')}%`;

function toScan(r: any) {
  return {
    id: r.id,
    pickNote: r.pick_note,
    clientName: r.client_name,
    clientCode: r.client_code,
    description: r.description,
    quantity: Number(r.quantity),
    user: { id: r.user_id, name: r.user_name || r.user_email || 'Unknown', email: r.user_email },
    capturedAt: r.captured_at,
    createdAt: r.created_at,
    imageUrl: `/api/scans/${r.id}/image`,
    thumbUrl: `/api/scans/${r.id}/image?size=thumb`,
    client: r.client_id ? { id: r.client_id, name: r.linked_client_name } : null,
    clientOrder: r.client_order_id ? { id: r.client_order_id, number: r.order_number } : null,
    dispatchNote: r.dispatch_note_id ? { id: r.dispatch_note_id, number: r.note_number, type: r.note_type } : null,
  };
}

const SELECT = `
  SELECT s.*, c.client_name AS linked_client_name, o.order_number, d.note_number, d.note_type
    FROM scans s
    LEFT JOIN clients c ON c.id = s.client_id
    LEFT JOIN client_orders o ON o.id = s.client_order_id
    LEFT JOIN dispatch_notes d ON d.id = s.dispatch_note_id`;

type Db = { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> };

/** What a pick note number (and the typed client name) points at in Tracklab. */
export async function resolveLinks(db: Db, pickNote: string, clientName: string | null) {
  const n = normaliseNumber(pickNote);
  const { rows: [order] } = await db.query(
    `SELECT o.id, o.order_number, o.client_id, c.client_name FROM client_orders o LEFT JOIN clients c ON c.id = o.client_id
      WHERE upper(regexp_replace(o.order_number, '\\s+', '', 'g')) = $1 LIMIT 1`, [n]);
  const { rows: [note] } = await db.query(
    `SELECT d.id, d.note_number, d.note_type, d.client_id, d.client_order_id, c.client_name FROM dispatch_notes d LEFT JOIN clients c ON c.id = d.client_id
      WHERE upper(regexp_replace(d.note_number, '\\s+', '', 'g')) = $1 LIMIT 1`, [n]);
  let clientId: number | null = order?.client_id ?? note?.client_id ?? null;
  let linkedClientName: string | null = order?.client_name ?? note?.client_name ?? null;
  if (!clientId && clientName) {
    // Only when exactly one client has that name: a guess between two would be worse than no link.
    const { rows } = await db.query(`SELECT id, client_name FROM clients WHERE lower(trim(client_name)) = lower($1) LIMIT 2`, [clientName]);
    if (rows.length === 1) { clientId = rows[0].id; linkedClientName = rows[0].client_name; }
  }
  return {
    clientOrderId: (order?.id ?? note?.client_order_id ?? null) as number | null,
    dispatchNoteId: (note?.id ?? null) as number | null,
    clientId,
    order: order ? { id: order.id, number: order.order_number } : null,
    dispatchNote: note ? { id: note.id, number: note.note_number, type: note.note_type } : null,
    client: clientId ? { id: clientId, name: linkedClientName } : null,
  };
}

// ---------------------------------------------------------------------------
// Routes.
// ---------------------------------------------------------------------------

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: SCAN_IMAGE_MAX_BYTES, files: 2, fields: 20, fieldSize: 2000 },
}).fields([{ name: 'image', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }]);

// Multer's own errors (too big, wrong field) as plain 4xx answers.
function receiveUpload(req: Request, res: Response, next: NextFunction): void {
  upload(req, res, (err: any) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return void res.status(413).json({ error: `The photo is too large (${SCAN_IMAGE_MAX_BYTES / 1024 / 1024} MB at most). Send a smaller or more compressed one.` });
    if (err.name === 'MulterError') return void res.status(400).json({ error: `Upload not understood: ${err.message}. Send the photo as the "image" file field.` });
    next(err);
  });
}

const fail = (res: Response, err: any, what: string) => {
  if (err?.status === 400) return res.status(400).json({ error: err.message });
  console.error(`[scans] ${what} failed:`, err?.message);
  res.status(500).json({ error: `Could not ${what}. Please try again.` });
};

export function registerScansRoutes(app: Express): void {
  app.post('/api/scans', receiveUpload, async (req: any, res) => {
    const client = await pool.connect();
    try {
      const fields = parseScanFields(req.body || {});
      const image: Express.Multer.File | undefined = req.files?.image?.[0];
      const thumb: Express.Multer.File | undefined = req.files?.thumbnail?.[0];
      if (!image) throw bad('Attach the photo as the "image" file.');
      const mime = sniffImageType(image.buffer);
      // HEIC (an iPhone's own format) is refused: browsers can't show it, so it would be a scan nobody can look at.
      if (!mime || mime === 'image/heic') throw bad(mime ? 'HEIC photos cannot be shown on the web. Send the photo as a JPEG.' : 'The photo must be a JPEG, PNG or WebP image.');
      // A thumbnail is a nicety: a bad or oversized one is dropped, not refused.
      const thumbMime = thumb && thumb.buffer.length <= SCAN_THUMB_MAX_BYTES ? sniffImageType(thumb.buffer) : null;

      // A resend of a scan that was already saved (the phone retrying after a dropped connection).
      if (fields.clientRef) {
        const { rows: [dup] } = await client.query(`${SELECT} WHERE s.client_ref = $1`, [fields.clientRef]);
        if (dup) return res.status(200).json({ ...toScan(dup), alreadySaved: true });
      }

      const me = await queryOne<{ email: string; first_name: string | null; last_name: string | null }>(
        `SELECT email, first_name, last_name FROM users WHERE id = $1`, [req.user.id]);
      const userName = [me?.first_name, me?.last_name].filter(Boolean).join(' ') || me?.email || req.user.email;

      await client.query('BEGIN');
      const links = await resolveLinks(client, fields.pickNote, fields.clientName);
      const imageKey = await scanImageStore.save({ data: image.buffer, mime }, client);
      const thumbKey = thumb && thumbMime ? await scanImageStore.save({ data: thumb.buffer, mime: thumbMime }, client) : null;
      const { rows: [saved] } = await client.query(
        `INSERT INTO scans (client_ref, user_id, user_email, user_name, pick_note, client_name, client_code, description, quantity,
                            image_key, thumb_key, client_id, client_order_id, dispatch_note_id, captured_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (client_ref) DO NOTHING RETURNING id`,
        // A matched number is saved the way Tracklab writes it; an unmatched one as typed.
        [fields.clientRef, req.user.id, req.user.email, userName, links.dispatchNote?.number ?? links.order?.number ?? fields.pickNote, fields.clientName, fields.clientCode,
         fields.description, fields.quantity, imageKey, thumbKey, links.clientId, links.clientOrderId, links.dispatchNoteId, fields.capturedAt]);
      if (!saved) {
        // Two copies of the same resend arrived together; the other one won.
        await client.query('ROLLBACK');
        const { rows: [dup] } = await client.query(`${SELECT} WHERE s.client_ref = $1`, [fields.clientRef]);
        return res.status(200).json({ ...toScan(dup), alreadySaved: true });
      }
      await client.query('COMMIT');
      const { rows: [row] } = await client.query(`${SELECT} WHERE s.id = $1`, [saved.id]);
      res.status(201).json(toScan(row));
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      fail(res, err, 'save the scan');
    } finally {
      client.release();
    }
  });

  app.get('/api/scans', async (req, res) => {
    try {
      const f = parseListQuery(req.query as any);
      const where: string[] = [];
      const params: any[] = [];
      const add = (sql: string, v: any) => { params.push(v); where.push(sql.replace(/\?/g, `$${params.length}`)); };
      if (f.pickNote) add(`s.pick_note ILIKE ?`, like(f.pickNote));
      if (f.user) add(`(s.user_name ILIKE ? OR s.user_email ILIKE ?)`, like(f.user));
      if (f.client) add(`(s.client_name ILIKE ? OR s.client_code ILIKE ? OR c.client_name ILIKE ?)`, like(f.client));
      if (f.from) add(`COALESCE(s.captured_at, s.created_at) >= ?::date`, f.from);
      if (f.to) add(`COALESCE(s.captured_at, s.created_at) < ?::date + 1`, f.to);
      if (f.clientOrderId) add(`s.client_order_id = ?`, f.clientOrderId);
      if (f.dispatchNoteId) add(`s.dispatch_note_id = ?`, f.dispatchNoteId);
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const { rows: [{ n }] } = await query(`SELECT count(*)::int AS n FROM scans s LEFT JOIN clients c ON c.id = s.client_id ${w}`, params);
      const { rows } = await query(
        `${SELECT} ${w} ORDER BY COALESCE(s.captured_at, s.created_at) DESC, s.id DESC LIMIT ${f.pageSize} OFFSET ${(f.page - 1) * f.pageSize}`, params);
      res.json({ items: rows.map(toScan), total: n, page: f.page, pageSize: f.pageSize });
    } catch (err) { fail(res, err, 'load the scans'); }
  });

  // Before /:id so "lookup" isn't read as an id.
  app.get('/api/scans/lookup', async (req, res) => {
    try {
      const pickNote = text(req.query.pickNote);
      if (!pickNote) return res.status(400).json({ error: 'Give a pickNote to look up.' });
      const l = await resolveLinks(pool, pickNote, text(req.query.clientName) || null);
      res.json({ pickNote, matched: !!(l.order || l.dispatchNote), clientOrder: l.order, dispatchNote: l.dispatchNote, client: l.client });
    } catch (err) { fail(res, err, 'look up the pick note'); }
  });

  app.get('/api/scans/:id', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(404).json({ error: 'Scan not found' });
      const row = await queryOne(`${SELECT} WHERE s.id = $1`, [id]);
      if (!row) return res.status(404).json({ error: 'Scan not found' });
      res.json(toScan(row));
    } catch (err) { fail(res, err, 'load the scan'); }
  });

  app.get('/api/scans/:id/image', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(404).json({ error: 'Scan not found' });
      const row = await queryOne<{ image_key: string; thumb_key: string | null }>(`SELECT image_key, thumb_key FROM scans WHERE id = $1`, [id]);
      if (!row) return res.status(404).json({ error: 'Scan not found' });
      const key = req.query.size === 'thumb' && row.thumb_key ? row.thumb_key : row.image_key;
      const img = await scanImageStore.load(key);
      if (!img) return res.status(404).json({ error: 'The photo for this scan is missing' });
      res.setHeader('Content-Type', img.mime);
      res.setHeader('Content-Length', String(img.data.length));
      // A scan's photo never changes, so the phone and browser may keep it.
      res.setHeader('Cache-Control', 'private, max-age=604800, immutable');
      res.end(img.data);
    } catch (err) { fail(res, err, 'load the photo'); }
  });

  app.delete('/api/scans/:id', async (req: any, res) => {
    const client = await pool.connect();
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(404).json({ error: 'Scan not found' });
      await client.query('BEGIN');
      const { rows: [row] } = await client.query(`SELECT id, user_id, pick_note, description, image_key, thumb_key FROM scans WHERE id = $1 FOR UPDATE`, [id]);
      if (!row) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Scan not found' }); }
      const mine = row.user_id != null && row.user_id === req.user.id;
      if (!mine && req.user.role !== 'admin') {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Only the person who took a scan, or an admin, can delete it.' });
      }
      await client.query(`DELETE FROM scans WHERE id = $1`, [id]);
      await scanImageStore.remove([row.image_key, row.thumb_key], client);
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      fail(res, err, 'delete the scan');
    } finally {
      client.release();
    }
  });
}
