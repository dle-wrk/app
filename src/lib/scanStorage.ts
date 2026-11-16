// Where scanner-app photos live. One small interface (save, load, remove)
// so the home can change without touching the routes: today the bytes sit
// in Postgres (scan_images, raw BYTEA, not base64 text), which needs no new
// account or secret. Moving to a bucket (Tigris, R2, S3) later means
// writing a second ScanImageStore and copying the rows across; keys are
// opaque strings, so the scans table doesn't change.

import { pool } from './db';

export interface StoredImage { data: Buffer; mime: string }

/** Anything that runs a query: the pool, or a client inside a transaction. */
type Db = { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> };

export interface ScanImageStore {
  save(img: StoredImage, db?: Db): Promise<string>;
  load(key: string): Promise<StoredImage | null>;
  remove(keys: (string | null | undefined)[], db?: Db): Promise<void>;
}

export const SCAN_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const SCAN_THUMB_MAX_BYTES = 512 * 1024;

/** The image type from its first bytes; what the phone claims is not trusted. Null when it isn't a photo we accept. */
export function sniffImageType(buf: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic' | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('ascii', 4, 8) === 'ftyp' && /^(heic|heix|hevc|mif1|msf1)$/.test(buf.toString('ascii', 8, 12))) return 'image/heic';
  return null;
}

export async function ensureScanImagesSchema(): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS scan_images (
    id SERIAL PRIMARY KEY,
    mime TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    data BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

// Keys look like "db:123" so a later store can tell its own keys apart.
export const dbImageStore: ScanImageStore = {
  async save(img, db = pool) {
    const { rows } = await db.query(
      `INSERT INTO scan_images (mime, bytes, data) VALUES ($1, $2, $3) RETURNING id`,
      [img.mime, img.data.length, img.data]);
    return `db:${rows[0].id}`;
  },
  async load(key) {
    const id = /^db:(\d+)$/.exec(key)?.[1];
    if (!id) return null;
    const { rows } = await pool.query(`SELECT mime, data FROM scan_images WHERE id = $1`, [Number(id)]);
    return rows[0] ? { mime: rows[0].mime, data: rows[0].data } : null;
  },
  async remove(keys, db = pool) {
    const ids = keys.map(k => /^db:(\d+)$/.exec(k || '')?.[1]).filter(Boolean).map(Number);
    if (ids.length) await db.query(`DELETE FROM scan_images WHERE id = ANY($1::int[])`, [ids]);
  },
};

export const scanImageStore: ScanImageStore = dbImageStore;
