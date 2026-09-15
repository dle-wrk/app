// Kitting surface — the "saved kit" workflow ported over from the
// standalone PySide6 kitting tool. A kit is a named production plan
// that freezes:
//   - the BOM lines at save time (kit_bom snapshot),
//   - which SKU is earmarked to fulfil each line (kit_allocations —
//     can point at an alternative SKU rather than the primary),
//   - the DNF marks the operator applied for this kit's audit,
//   - and, when lock mode is on, a reservation against inventory so
//     another kit's audit sees that stock as spoken-for.
//
// Data-model note: the reference Python tool operates on per-reel
// rows in inventory. TrackLab stores one row per SKU with aggregate
// stock, so allocations here are per-SKU quantities, not per-reel
// serials. Multi-tier alternative matching still applies — it just
// returns candidate SKUs instead of candidate reels.

import type { Express } from 'express';
import { z } from 'zod';
import { pool, query, queryOne, exec } from './db';
import { requireAdmin } from './authRoutes';

export async function ensureKitsSchema(): Promise<void> {
  // Wrapped in try/catch per statement so a partial schema (e.g. old
  // deployment already had one of these tables) doesn't abort the rest.
  await exec(`CREATE TABLE IF NOT EXISTS kits (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    project_id INTEGER,
    build_qty INTEGER NOT NULL DEFAULT 1,
    lock_mode BOOLEAN DEFAULT FALSE,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by TEXT
  )`).catch(() => {});
  await exec(`CREATE TABLE IF NOT EXISTS kit_bom (
    id SERIAL PRIMARY KEY,
    kit_id INTEGER REFERENCES kits(id) ON DELETE CASCADE,
    stock_code TEXT NOT NULL,
    qty_per_pcb INTEGER NOT NULL DEFAULT 1,
    designator TEXT DEFAULT '',
    description TEXT DEFAULT '',
    footprint TEXT DEFAULT ''
  )`).catch(() => {});
  await exec(`CREATE TABLE IF NOT EXISTS kit_allocations (
    id SERIAL PRIMARY KEY,
    kit_id INTEGER REFERENCES kits(id) ON DELETE CASCADE,
    stock_code TEXT NOT NULL,
    allocated_code TEXT NOT NULL,
    qty INTEGER NOT NULL
  )`).catch(() => {});
  await exec(`CREATE TABLE IF NOT EXISTS kit_dnf (
    kit_id INTEGER REFERENCES kits(id) ON DELETE CASCADE,
    stock_code TEXT NOT NULL,
    PRIMARY KEY (kit_id, stock_code)
  )`).catch(() => {});
  // Reservations table decouples the "lock" concept from inventory
  // status. Each row says "kit N has qty Q of allocated_code reserved
  // for later book-out". When lock_mode is on, saves populate this
  // table; the kit-booking audit subtracts other kits' active
  // reservations from what it treats as available stock.
  await exec(`CREATE TABLE IF NOT EXISTS kit_reservations (
    id SERIAL PRIMARY KEY,
    kit_id INTEGER REFERENCES kits(id) ON DELETE CASCADE,
    allocated_code TEXT NOT NULL,
    qty INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`).catch(() => {});
  await exec(`CREATE INDEX IF NOT EXISTS idx_kit_bom_kit ON kit_bom(kit_id)`).catch(() => {});
  await exec(`CREATE INDEX IF NOT EXISTS idx_kit_allocations_kit ON kit_allocations(kit_id)`).catch(() => {});
  await exec(`CREATE INDEX IF NOT EXISTS idx_kit_allocations_code ON kit_allocations(stock_code)`).catch(() => {});
  await exec(`CREATE INDEX IF NOT EXISTS idx_kit_reservations_code ON kit_reservations(allocated_code)`).catch(() => {});
}

// ----- Helpers --------------------------------------------------------------

async function loadFullKit(kitId: number): Promise<any | null> {
  const kit = await queryOne<any>(
    `SELECT id, name, project_id, build_qty, lock_mode, notes, created_at, updated_at, created_by
       FROM kits WHERE id = $1`,
    [kitId]
  );
  if (!kit) return null;
  const { rows: bom } = await query(
    `SELECT stock_code, qty_per_pcb, designator, description, footprint FROM kit_bom WHERE kit_id = $1 ORDER BY id`,
    [kitId]
  );
  const { rows: allocs } = await query(
    `SELECT stock_code, allocated_code, qty FROM kit_allocations WHERE kit_id = $1 ORDER BY id`,
    [kitId]
  );
  const { rows: dnf } = await query(
    `SELECT stock_code FROM kit_dnf WHERE kit_id = $1`,
    [kitId]
  );
  return {
    id: kit.id,
    name: kit.name,
    projectId: kit.project_id,
    buildQty: kit.build_qty,
    lockMode: !!kit.lock_mode,
    notes: kit.notes || '',
    createdAt: kit.created_at,
    updatedAt: kit.updated_at,
    createdBy: kit.created_by || '',
    bom: bom.map((r: any) => ({
      stockCode: r.stock_code,
      qtyPerPcb: r.qty_per_pcb,
      designator: r.designator || '',
      description: r.description || '',
      footprint: r.footprint || '',
    })),
    allocations: allocs.map((r: any) => ({
      stockCode: r.stock_code,
      allocatedCode: r.allocated_code,
      qty: r.qty,
    })),
    dnf: dnf.map((r: any) => r.stock_code),
  };
}

// Rewrites the reservation rows for a kit: if lock_mode is on, one row
// per allocation carrying the earmarked qty; if off, none. Called under
// a transaction so audits from other kits can never see a half-written
// reservation set.
async function rewriteReservationsInTx(client: any, kitId: number, lockMode: boolean, allocations: Array<{ allocatedCode: string; qty: number }>) {
  await client.query(`DELETE FROM kit_reservations WHERE kit_id = $1`, [kitId]);
  if (!lockMode) return;
  for (const a of allocations) {
    if (!a.allocatedCode || a.qty <= 0) continue;
    await client.query(
      `INSERT INTO kit_reservations (kit_id, allocated_code, qty) VALUES ($1, $2, $3)`,
      [kitId, a.allocatedCode, a.qty]
    );
  }
}

// ----- Zod schema for save/update -----------------------------------------

const KitSaveBody = z.object({
  name: z.string().min(1).max(200).transform(v => v.trim()),
  projectId: z.number().int().nullable().optional(),
  buildQty: z.number().int().min(1).max(100_000),
  lockMode: z.boolean().optional().default(false),
  notes: z.string().max(2000).optional().default(''),
  bom: z.array(z.object({
    stockCode: z.string().min(1).max(200),
    qtyPerPcb: z.number().int().min(1).max(1_000_000),
    designator: z.string().max(500).optional().default(''),
    description: z.string().max(1000).optional().default(''),
    footprint: z.string().max(200).optional().default(''),
  })).min(1),
  allocations: z.array(z.object({
    stockCode: z.string().min(1).max(200),
    allocatedCode: z.string().min(1).max(200),
    qty: z.number().int().min(1).max(10_000_000),
  })).default([]),
  dnf: z.array(z.string().max(200)).default([]),
});

// ----- Routes -------------------------------------------------------------

export function registerKitsRoutes(app: Express): void {
  // GET /api/kits — summary list for the Saved Kits browser. Includes a
  // compact stockCodes array per kit (union of kit_bom + kit_allocations
  // + kit_dnf) so BOM Manager can build a reverse lookup without a
  // per-row round-trip.
  app.get('/api/kits', async (_req, res) => {
    try {
      const { rows } = await query(`
        SELECT k.id, k.name, k.project_id, k.build_qty, k.lock_mode, k.created_at, k.updated_at, k.created_by,
               p.project_name,
               (SELECT COUNT(*)::int FROM kit_bom WHERE kit_id = k.id) AS bom_lines,
               (SELECT COUNT(*)::int FROM kit_allocations WHERE kit_id = k.id) AS allocation_lines,
               (SELECT COUNT(*)::int FROM kit_dnf WHERE kit_id = k.id) AS dnf_count,
               COALESCE((
                 SELECT ARRAY_AGG(DISTINCT sc)
                   FROM (
                     SELECT stock_code AS sc FROM kit_bom WHERE kit_id = k.id
                     UNION ALL
                     SELECT stock_code FROM kit_allocations WHERE kit_id = k.id
                     UNION ALL
                     SELECT allocated_code FROM kit_allocations WHERE kit_id = k.id
                     UNION ALL
                     SELECT stock_code FROM kit_dnf WHERE kit_id = k.id
                   ) u
               ), ARRAY[]::text[]) AS stock_codes
          FROM kits k
     LEFT JOIN projects p ON p.id::text = k.project_id::text
      ORDER BY k.updated_at DESC
      `);
      res.json(rows.map((r: any) => ({
        id: r.id,
        name: r.name,
        projectId: r.project_id,
        projectName: r.project_name || null,
        buildQty: r.build_qty,
        lockMode: !!r.lock_mode,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        createdBy: r.created_by || '',
        bomLines: r.bom_lines,
        allocationLines: r.allocation_lines,
        dnfCount: r.dnf_count,
        stockCodes: Array.isArray(r.stock_codes) ? r.stock_codes.filter((s: any) => !!s) : [],
      })));
    } catch (err: any) {
      console.error('[kits:list] failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/kits/:id — full kit for load-into-editor
  app.get('/api/kits/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    try {
      const kit = await loadFullKit(id);
      if (!kit) return res.status(404).json({ error: 'kit not found' });
      res.json(kit);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/projects/:id/kits — kits scoped to one project, for the
  // Project Manager card cross-link.
  app.get('/api/projects/:id/kits', async (req, res) => {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    try {
      const { rows } = await query(
        `SELECT id, name, build_qty, lock_mode, created_at, updated_at
           FROM kits WHERE project_id = $1 ORDER BY updated_at DESC`,
        [id]
      );
      res.json(rows.map((r: any) => ({
        id: r.id,
        name: r.name,
        buildQty: r.build_qty,
        lockMode: !!r.lock_mode,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/kits/using/:stockCode — which kits reference a stock code
  // either as a BOM line or as an earmarked alternative. Powers the
  // "Used in kits: A, B" badge on BOM Manager rows.
  app.get('/api/kits/using/:stockCode', async (req, res) => {
    const code = String(req.params.stockCode || '').trim();
    if (!code) return res.status(400).json({ error: 'invalid stockCode' });
    try {
      const { rows } = await query(
        `SELECT DISTINCT k.id, k.name, k.build_qty
           FROM kits k
           LEFT JOIN kit_bom b ON b.kit_id = k.id
           LEFT JOIN kit_allocations a ON a.kit_id = k.id
          WHERE b.stock_code = $1 OR a.stock_code = $1 OR a.allocated_code = $1
          ORDER BY k.updated_at DESC`,
        [code]
      );
      res.json(rows.map((r: any) => ({ id: r.id, name: r.name, buildQty: r.build_qty })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/kits — create OR overwrite an existing kit by name. The
  // name uniqueness constraint mirrors the reference tool: reusing an
  // existing name is treated as an intentional overwrite.
  app.post('/api/kits', async (req: any, res) => {
    const parsed = KitSaveBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid body', details: parsed.error.flatten() });
    const body = parsed.data;
    const user = req.user?.email || null;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(`SELECT id FROM kits WHERE name = $1`, [body.name]);
      let kitId: number;
      if (existing.rows.length > 0) {
        kitId = existing.rows[0].id;
        await client.query(
          `UPDATE kits SET project_id=$1, build_qty=$2, lock_mode=$3, notes=$4, updated_at=CURRENT_TIMESTAMP WHERE id=$5`,
          [body.projectId ?? null, body.buildQty, body.lockMode, body.notes, kitId]
        );
        await client.query(`DELETE FROM kit_bom WHERE kit_id=$1`, [kitId]);
        await client.query(`DELETE FROM kit_allocations WHERE kit_id=$1`, [kitId]);
        await client.query(`DELETE FROM kit_dnf WHERE kit_id=$1`, [kitId]);
      } else {
        const ins = await client.query(
          `INSERT INTO kits (name, project_id, build_qty, lock_mode, notes, created_by)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [body.name, body.projectId ?? null, body.buildQty, body.lockMode, body.notes, user]
        );
        kitId = ins.rows[0].id;
      }
      for (const b of body.bom) {
        await client.query(
          `INSERT INTO kit_bom (kit_id, stock_code, qty_per_pcb, designator, description, footprint)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [kitId, b.stockCode, b.qtyPerPcb, b.designator, b.description, b.footprint]
        );
      }
      for (const a of body.allocations) {
        await client.query(
          `INSERT INTO kit_allocations (kit_id, stock_code, allocated_code, qty) VALUES ($1,$2,$3,$4)`,
          [kitId, a.stockCode, a.allocatedCode, a.qty]
        );
      }
      for (const code of body.dnf) {
        await client.query(
          `INSERT INTO kit_dnf (kit_id, stock_code) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [kitId, code]
        );
      }
      await rewriteReservationsInTx(client, kitId, body.lockMode, body.allocations);
      await client.query('COMMIT');
      const full = await loadFullKit(kitId);
      res.json(full);
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[kits:save] failed:', err.message);
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  // DELETE /api/kits/:id — hard delete (cascade drops rows in the child
  // tables and reservations). Admin-gated because deleting a locked kit
  // silently frees its reserved stock for other kits.
  app.delete('/api/kits/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    try {
      const r = await query(`DELETE FROM kits WHERE id = $1`, [id]);
      if (r.rowCount === 0) return res.status(404).json({ error: 'kit not found' });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/kits/match/:stockCode — multi-tier alternative match, port
  // of find_matching_reels() in the reference tool but operating on
  // SKU rows in `inventory` plus our `alternative_components` table.
  //
  //   Tier 1 — exact serial match (the anchor SKU itself)
  //   Tier 2 — same name AND same footprint
  //   Tier 3 — same name (footprint differs)
  //   Tier 4 — substring name match (compatible footprints)
  //   Tier 0 (mapped to 1.5) — explicitly listed in alternative_components
  app.get('/api/kits/match/:stockCode', async (req, res) => {
    const code = String(req.params.stockCode || '').trim();
    if (!code) return res.status(400).json({ error: 'invalid stockCode' });
    try {
      const anchor = await queryOne<any>(
        `SELECT serial_number, name, description, footprint, stock, status FROM inventory WHERE serial_number = $1`,
        [code]
      );
      if (!anchor) return res.json([]);
      const anchorName = String(anchor.name || '').trim();
      const anchorFp = String(anchor.footprint || '').trim();

      // Bring in the operator's manually-declared alternatives first —
      // they always outrank fuzzy name/footprint hits below.
      const { rows: manualAltRows } = await query<{ alternative_part_number: string }>(
        `SELECT alternative_part_number FROM alternative_components WHERE primary_part_number = $1`,
        [code]
      );
      const manualAlts = new Set(manualAltRows.map(r => r.alternative_part_number));

      const { rows: all } = await query<any>(
        `SELECT serial_number, name, description, footprint, stock, status FROM inventory`
      );
      const results: any[] = [];
      const seen = new Set<string>();
      for (const r of all) {
        const sn = r.serial_number;
        if (!sn || seen.has(sn)) continue;
        const name = String(r.name || '').trim();
        const fp = String(r.footprint || '').trim();
        let tier = 0;
        let note = '';
        if (sn === code) {
          tier = 1; note = 'Exact match (primary SKU)';
        } else if (manualAlts.has(sn)) {
          tier = 2; note = 'Approved alternative (from alternates table)';
        } else if (name && anchorName && name === anchorName && fp && anchorFp && fp === anchorFp) {
          tier = 2; note = 'Equivalent — same Name + Footprint';
        } else if (name && anchorName && name === anchorName) {
          tier = 3; note = 'Same Name, footprint differs — verify';
        } else if (name && anchorName && (name.includes(anchorName) || anchorName.includes(name))) {
          const fpOk = !fp || !anchorFp || fp === anchorFp;
          if (fpOk) { tier = 4; note = 'Similar Name — verify carefully'; }
        }
        if (tier > 0) {
          seen.add(sn);
          results.push({
            serialNumber: sn,
            name,
            description: r.description || '',
            footprint: fp,
            stock: parseInt(r.stock || '0') || 0,
            status: r.status || 'ACTIVE',
            matchTier: tier,
            matchNote: note,
          });
        }
      }
      results.sort((a, b) => a.matchTier - b.matchTier || String(a.serialNumber).localeCompare(String(b.serialNumber)));
      res.json(results);
    } catch (err: any) {
      console.error('[kits:match] failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/kits/reservations — snapshot of currently-locked qty per
  // SKU aggregated across every kit that carries a reservation. Called
  // by the kit-booking audit so it can subtract "reserved elsewhere"
  // from the stock the operator has to plan against.
  app.get('/api/kits/reservations', async (_req, res) => {
    try {
      const { rows } = await query(
        `SELECT allocated_code, SUM(qty)::int AS reserved_qty FROM kit_reservations GROUP BY allocated_code`
      );
      const out: Record<string, number> = {};
      for (const r of rows as any[]) out[r.allocated_code] = r.reserved_qty;
      res.json(out);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
