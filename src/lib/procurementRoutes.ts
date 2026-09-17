// Procurement Shortage Checker — merges N kit-booking shortage CSVs,
// dedupes by part number, and stores the result as a named
// procurement project the buyer can reload later. Data is small (tens
// to a few hundred rows per project), so the merged rows are held
// inline as JSONB rather than a normalised child table — this keeps
// save/load one round-trip and avoids a schema migration for what is
// essentially a spreadsheet.

import type { Express } from 'express';
import { z } from 'zod';
import { query, queryOne, exec } from './db';

export async function ensureProcurementSchema(): Promise<void> {
  await exec(`CREATE TABLE IF NOT EXISTS procurement_projects (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    notes TEXT,
    row_count INTEGER DEFAULT 0,
    total_shortage BIGINT DEFAULT 0,
    rows JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by TEXT
  )`).catch(() => {});
}

const RowSchema = z.object({
  part: z.string().min(1).max(200),
  description: z.string().max(2000).optional().default(''),
  designator: z.string().max(4000).optional().default(''),
  qtyPerPcb: z.coerce.number().int().min(0).default(0),
  needed: z.coerce.number().int().min(0).default(0),
  onHand: z.coerce.number().int().min(0).default(0),
  shortage: z.coerce.number().int().min(0).default(0),
  alternatesUsed: z.string().max(400).optional().default(''),
  reservedElsewhere: z.coerce.number().int().min(0).default(0),
  sourceFiles: z.array(z.string().max(400)).default([]),
});

const SaveBody = z.object({
  name: z.string().min(1).max(200).transform(s => s.trim()),
  notes: z.string().max(2000).optional().default(''),
  rows: z.array(RowSchema).min(1),
});

export function registerProcurementRoutes(app: Express): void {
  app.get('/api/procurement-projects', async (_req, res) => {
    try {
      const { rows } = await query(
        `SELECT id, name, notes, row_count, total_shortage, created_at, updated_at, created_by
           FROM procurement_projects ORDER BY updated_at DESC`
      );
      res.json(rows.map((r: any) => ({
        id: r.id,
        name: r.name,
        notes: r.notes || '',
        rowCount: r.row_count,
        totalShortage: Number(r.total_shortage) || 0,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        createdBy: r.created_by || '',
      })));
    } catch (err: any) {
      console.error('[procurement:list] failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/procurement-projects/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    try {
      const row = await queryOne<any>(
        `SELECT id, name, notes, rows, row_count, total_shortage, created_at, updated_at, created_by
           FROM procurement_projects WHERE id = $1`,
        [id]
      );
      if (!row) return res.status(404).json({ error: 'not found' });
      res.json({
        id: row.id,
        name: row.name,
        notes: row.notes || '',
        rows: Array.isArray(row.rows) ? row.rows : [],
        rowCount: row.row_count,
        totalShortage: Number(row.total_shortage) || 0,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        createdBy: row.created_by || '',
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/procurement-projects — upsert by name so a re-save from
  // the UI on the same name overwrites cleanly rather than creating
  // a second row you have to prune later.
  app.post('/api/procurement-projects', async (req: any, res) => {
    const parsed = SaveBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid body', details: parsed.error.flatten() });
    const body = parsed.data;
    const user = req.user?.email || null;
    const totalShortage = body.rows.reduce((s, r) => s + (r.shortage || 0), 0);
    try {
      const existing = await queryOne<{ id: number }>(`SELECT id FROM procurement_projects WHERE name = $1`, [body.name]);
      if (existing) {
        await query(
          `UPDATE procurement_projects
              SET notes = $1, rows = $2::jsonb, row_count = $3, total_shortage = $4, updated_at = CURRENT_TIMESTAMP
            WHERE id = $5`,
          [body.notes, JSON.stringify(body.rows), body.rows.length, totalShortage, existing.id]
        );
        res.json({ ok: true, id: existing.id, replaced: true });
      } else {
        const { rows } = await query(
          `INSERT INTO procurement_projects (name, notes, rows, row_count, total_shortage, created_by)
           VALUES ($1, $2, $3::jsonb, $4, $5, $6) RETURNING id`,
          [body.name, body.notes, JSON.stringify(body.rows), body.rows.length, totalShortage, user]
        );
        res.status(201).json({ ok: true, id: rows[0].id, replaced: false });
      }
    } catch (err: any) {
      console.error('[procurement:save] failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/procurement-projects/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    try {
      const r = await query(`DELETE FROM procurement_projects WHERE id = $1`, [id]);
      if (r.rowCount === 0) return res.status(404).json({ error: 'not found' });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/procurement-projects/mfn?parts=X,Y,Z — returns the primary
  // manufacturer part number for each requested SKU so the CSV export
  // can carry an MFN column without dragging inventory over the wire.
  app.get('/api/inventory/mfn', async (req, res) => {
    const raw = String(req.query.parts || '');
    const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length === 0) return res.json({});
    try {
      const { rows } = await query<{ serial_number: string; man_pn_1: string | null }>(
        `SELECT serial_number, man_pn_1 FROM inventory WHERE serial_number = ANY($1::text[])`,
        [parts]
      );
      const out: Record<string, string> = {};
      for (const r of rows) out[r.serial_number] = r.man_pn_1 || '';
      res.json(out);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
