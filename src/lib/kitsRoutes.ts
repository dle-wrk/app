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

// Cheap fire-and-forget writer into user_activity_logs — used by the
// kit endpoints so every SAVE_KIT / IMPORT_KIT / SYNC_BOM /
// DELETE_KIT / CREATE_PROJECT_FROM_KIT event lands in the same log the
// UI already renders under Activity Logs. A failure here never fails
// the outer request; audit gaps are less bad than losing the write.
async function logKitEvent(req: any, action: string, opts: { entityId?: string | number | null; details?: any; status?: 'SUCCESS' | 'ERROR' } = {}) {
  try {
    const email = req?.user?.email;
    if (!email) return;
    const xf = String(req.headers?.['x-forwarded-for'] || '');
    const ip = xf.split(',')[0].trim() || (req.socket?.remoteAddress || '').split(':').pop() || '';
    const ua = String(req.headers?.['user-agent'] || '');
    await query(
      `INSERT INTO user_activity_logs (user_email, action, entity_type, entity_id, details, ip_address, user_agent, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [email, action, 'Kit', opts.entityId != null ? String(opts.entityId) : null, JSON.stringify(opts.details || {}), ip, ua, opts.status || 'SUCCESS']
    );
  } catch (err: any) {
    console.warn(`[activity-log] failed for ${action}:`, err.message);
  }
}

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
  // Lightweight presence table for the "Sam is editing this kit"
  // banner. One row per (kit, user) is heartbeat-updated by the
  // client every ~10s while the kit is loaded; GET filters to rows
  // seen within the last minute. Deliberately not FK-cascaded — a
  // stale row is fine, the age filter drops it anyway.
  await exec(`CREATE TABLE IF NOT EXISTS kit_presence (
    kit_id INTEGER NOT NULL,
    user_email TEXT NOT NULL,
    user_name TEXT,
    last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (kit_id, user_email)
  )`).catch(() => {});
  await exec(`CREATE INDEX IF NOT EXISTS idx_kit_bom_kit ON kit_bom(kit_id)`).catch(() => {});
  await exec(`CREATE INDEX IF NOT EXISTS idx_kit_allocations_kit ON kit_allocations(kit_id)`).catch(() => {});
  await exec(`CREATE INDEX IF NOT EXISTS idx_kit_allocations_code ON kit_allocations(stock_code)`).catch(() => {});
  await exec(`CREATE INDEX IF NOT EXISTS idx_kit_reservations_code ON kit_reservations(allocated_code)`).catch(() => {});
  await exec(`CREATE INDEX IF NOT EXISTS idx_kit_presence_seen ON kit_presence(last_seen)`).catch(() => {});
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
  // When true, the save also rewrites the project's db_bom rows to
  // match the kit's BOM exactly — clears every row for this project
  // across the eligible tables (db_bom, db_bom_ncu04, db_bom_loradongle,
  // db_bom_project_<N>) and reinserts into the canonical per-project
  // table. Off by default so an in-app Save Kit never silently clobbers
  // the project BOM; the import flow flips it on because that's the
  // whole point of dropping a CSV.
  syncToProjectBom: z.boolean().optional().default(false),
  // Auto-create a project row named after the kit if none matches
  // the name (case-insensitive). Combined with syncToProjectBom this
  // gives the "Save Kit → have a real project row show up in Project
  // Manager and BOM Manager pointing at these BOM lines" workflow.
  createProjectIfMissing: z.boolean().optional().default(false),
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

      // Optional: auto-provision a project row named after the kit if
      // the operator asked for it AND no project already carries this
      // name (case-insensitive). The new project becomes the kit's
      // projectId for the rest of the save so kit → project → BOM all
      // chain to the same row.
      let effectiveProjectId: number | null = body.projectId ?? null;
      let createdProject: { id: number; name: string } | null = null;
      if (body.createProjectIfMissing) {
        const stamp = new Date().toISOString().slice(0, 10);
        const desiredName = `${body.name} (${stamp})`;
        const nameMatch = await client.query(
          `SELECT id, project_name FROM projects WHERE LOWER(project_name) = LOWER($1) LIMIT 1`,
          [desiredName]
        );
        if (nameMatch.rows.length > 0) {
          effectiveProjectId = parseInt(nameMatch.rows[0].id) || null;
        } else {
          // MAX(id)+1 mirrors the pattern in projectsRoutes for
          // consistency with the existing projects endpoint.
          const nextRow = await client.query(
            `SELECT COALESCE(MAX(id::integer), 0) + 1 AS next_id FROM projects`
          );
          const nextId = parseInt(nextRow.rows[0].next_id) || 1;
          await client.query(
            `INSERT INTO projects (id, project_name, description, status, created_date, updated_at)
             VALUES ($1, $2, $3, 'Active', $4, now())`,
            [String(nextId), desiredName, `Auto-created from kit "${body.name}"`, stamp]
          );
          effectiveProjectId = nextId;
          createdProject = { id: nextId, name: desiredName };
        }
      }

      const existing = await client.query(`SELECT id FROM kits WHERE name = $1`, [body.name]);
      let kitId: number;
      if (existing.rows.length > 0) {
        kitId = existing.rows[0].id;
        await client.query(
          `UPDATE kits SET project_id=$1, build_qty=$2, lock_mode=$3, notes=$4, updated_at=CURRENT_TIMESTAMP WHERE id=$5`,
          [effectiveProjectId, body.buildQty, body.lockMode, body.notes, kitId]
        );
        await client.query(`DELETE FROM kit_bom WHERE kit_id=$1`, [kitId]);
        await client.query(`DELETE FROM kit_allocations WHERE kit_id=$1`, [kitId]);
        await client.query(`DELETE FROM kit_dnf WHERE kit_id=$1`, [kitId]);
      } else {
        const ins = await client.query(
          `INSERT INTO kits (name, project_id, build_qty, lock_mode, notes, created_by)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [body.name, effectiveProjectId, body.buildQty, body.lockMode, body.notes, user]
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

      // Optional: rewrite the project's BOM to match this kit's BOM
      // exactly. Fires from the CSV/JSON import flow by default. Skipped
      // otherwise so an in-app Save never silently clobbers hand-edited
      // rows. Steps:
      //   1. Ensure db_bom_project_<pid> exists as the canonical write
      //      target (matches ensureCanonicalTable in productionRoutes).
      //   2. Delete every row for this project across the eligible
      //      audit tables so the audit + BOM Manager see only what
      //      the kit carries.
      //   3. Insert the kit's BOM lines into db_bom_project_<pid>.
      //   4. Bump projects.updated_at so the Last-edited chip reflects
      //      the change immediately.
      let bomSynced = false;
      let backup: any = null;
      if (body.syncToProjectBom && effectiveProjectId) {
        const pid = effectiveProjectId;
        const table = `db_bom_project_${pid}`;
        await client.query(`CREATE TABLE IF NOT EXISTS "${table}" (
          project_name text,
          internal_stock_number text,
          qty_per_unit integer,
          ref_des text,
          description text,
          comment text,
          footprint text,
          libref text
        )`);
        // Drop the (internal_stock_number) primary key if a legacy
        // schema left one on this table. A real BOM can legitimately
        // carry multiple rows for the same stock code (different
        // designators, different comments), and the read path already
        // aggregates at query time — the pkey was a mistake.
        await client.query(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${table}_pkey"`).catch(() => {});

        const universals = ['db_bom', 'db_bom_ncu04', 'db_bom_loradongle', table];

        // 1. Snapshot every existing row for this project across the
        //    audit tables BEFORE deleting, tagging each with its
        //    source table so a later restore can round-trip.
        const backupRows: any[] = [];
        for (const t of universals) {
          const exists = await client.query(`SELECT to_regclass($1) AS r`, [`public.${t}`]);
          if (!exists.rows[0]?.r) continue;
          const { rows } = await client.query(
            `SELECT * FROM "${t}" WHERE project_name::text = $1`,
            [String(pid)]
          );
          for (const r of rows) backupRows.push({ _table: t, ...r });
        }
        const projMeta = await client.query(`SELECT project_name, created_date FROM projects WHERE id::int = $1`, [pid]);
        const projectName = projMeta.rows[0]?.project_name || `project_${pid}`;
        backup = {
          projectId: pid,
          projectName,
          projectCreatedDate: projMeta.rows[0]?.created_date || null,
          backupCreatedAt: new Date().toISOString(),
          replacedByKit: body.name,
          rowCount: backupRows.length,
          rows: backupRows,
        };

        // 2. Delete every row for this project across the eligible
        //    tables so the audit + BOM Manager see only what the kit
        //    carries.
        for (const t of universals) {
          const exists = await client.query(`SELECT to_regclass($1) AS r`, [`public.${t}`]);
          if (!exists.rows[0]?.r) continue;
          await client.query(`DELETE FROM "${t}" WHERE project_name::text = $1`, [String(pid)]);
        }

        // 3. Insert the kit's BOM lines verbatim — one row per input,
        //    no aggregation. The pkey drop above lets multiple rows
        //    share a stock code (per-designator entries).
        for (const b of body.bom) {
          await client.query(
            `INSERT INTO "${table}" (project_name, internal_stock_number, qty_per_unit, ref_des, description, comment, footprint, libref)
             VALUES ($1, $2, $3, $4, $5, $6, $7, '')`,
            [String(pid), b.stockCode, b.qtyPerPcb, b.designator, b.description, '', b.footprint]
          );
        }
        await client.query(`UPDATE projects SET updated_at = now() WHERE id::int = $1`, [pid]).catch(() => {});
        bomSynced = true;
      }

      await client.query('COMMIT');
      if (bomSynced) console.log(`[kits:save] project=${effectiveProjectId} bom synced from kit "${body.name}" (${body.bom.length} lines, ${backup?.rowCount || 0} rows backed up)`);
      // Activity ledger: one row per meaningful outcome. Multiple in a
      // single save is fine — they read as a coherent "user X did all
      // of this at HH:MM:SS" grouping in the Activity Logs view.
      if (createdProject) {
        void logKitEvent(req, 'CREATE_PROJECT_FROM_KIT', {
          entityId: createdProject.id,
          details: { projectName: createdProject.name, kitName: body.name, bomLines: body.bom.length },
        });
      }
      if (bomSynced) {
        void logKitEvent(req, 'SYNC_BOM', {
          entityId: effectiveProjectId,
          details: { projectId: effectiveProjectId, kitName: body.name, bomLines: body.bom.length, backedUpRows: backup?.rowCount || 0 },
        });
      }
      void logKitEvent(req, existing.rows.length > 0 ? 'UPDATE_KIT' : 'SAVE_KIT', {
        entityId: kitId,
        details: {
          kitName: body.name,
          projectId: effectiveProjectId,
          buildQty: body.buildQty,
          bomLines: body.bom.length,
          allocations: body.allocations.length,
          dnf: body.dnf.length,
          lockMode: body.lockMode,
          syncedToProjectBom: bomSynced,
          createdProject: !!createdProject,
        },
      });
      const full = await loadFullKit(kitId);
      res.json({ ...full, bomSynced, backup, createdProject });
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
      // Grab the name before the delete so the activity log carries
      // human-readable context even after the row is gone.
      const meta = await queryOne<{ name: string }>(`SELECT name FROM kits WHERE id = $1`, [id]);
      const r = await query(`DELETE FROM kits WHERE id = $1`, [id]);
      if (r.rowCount === 0) return res.status(404).json({ error: 'kit not found' });
      void logKitEvent(req, 'DELETE_KIT', { entityId: id, details: { kitName: meta?.name || `#${id}` } });
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

  // POST /api/kits/match/batch — match many stock codes in one call.
  // The single-code endpoint does a full inventory scan per request,
  // which for a 126-line BOM adds up to 126 full scans and a slow
  // "auto-allocate all" experience. The batch version reads inventory
  // ONCE, indexes it, and evaluates each anchor against that index —
  // O(N × M) instead of O(N × M²) round-trips. Response is a map
  // keyed by input stock code.
  app.post('/api/kits/match/batch', async (req, res) => {
    const codes: string[] = Array.isArray(req.body?.stockCodes) ? req.body.stockCodes : [];
    if (codes.length === 0) return res.json({});
    // Cap the batch so a runaway request can't scan the DB and hold
    // memory forever. 500 covers the biggest BOMs in the current
    // dataset with headroom; the client walks by-project so this is
    // never hit in normal use.
    const capped = codes.slice(0, 500);
    try {
      const { rows: allRows } = await query<any>(
        `SELECT serial_number, name, description, footprint, stock, status FROM inventory`
      );
      // Load every approved-alt pair for the requested anchors in a
      // single query, then index by primary code so the per-anchor
      // loop is a plain map lookup.
      const { rows: altRows } = await query<{ primary_part_number: string; alternative_part_number: string }>(
        `SELECT primary_part_number, alternative_part_number FROM alternative_components WHERE primary_part_number = ANY($1::text[])`,
        [capped]
      );
      const manualAltsByAnchor: Record<string, Set<string>> = {};
      for (const row of altRows) {
        if (!manualAltsByAnchor[row.primary_part_number]) manualAltsByAnchor[row.primary_part_number] = new Set();
        manualAltsByAnchor[row.primary_part_number].add(row.alternative_part_number);
      }
      const inventoryByCode: Record<string, any> = {};
      for (const r of allRows) if (r.serial_number) inventoryByCode[r.serial_number] = r;

      const out: Record<string, any[]> = {};
      for (const code of capped) {
        const anchor = inventoryByCode[code];
        if (!anchor) { out[code] = []; continue; }
        const anchorName = String(anchor.name || '').trim();
        const anchorFp = String(anchor.footprint || '').trim();
        const manualAlts = manualAltsByAnchor[code] || new Set<string>();
        const results: any[] = [];
        const seen = new Set<string>();
        for (const r of allRows) {
          const sn = r.serial_number;
          if (!sn || seen.has(sn)) continue;
          const name = String(r.name || '').trim();
          const fp = String(r.footprint || '').trim();
          let tier = 0;
          let note = '';
          if (sn === code) { tier = 1; note = 'Exact match (primary SKU)'; }
          else if (manualAlts.has(sn)) { tier = 2; note = 'Approved alternative (from alternates table)'; }
          else if (name && anchorName && name === anchorName && fp && anchorFp && fp === anchorFp) { tier = 2; note = 'Equivalent — same Name + Footprint'; }
          else if (name && anchorName && name === anchorName) { tier = 3; note = 'Same Name, footprint differs — verify'; }
          else if (name && anchorName && (name.includes(anchorName) || anchorName.includes(name))) {
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
        out[code] = results;
      }
      res.json(out);
    } catch (err: any) {
      console.error('[kits:match:batch] failed:', err.message);
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

  // --- Presence ------------------------------------------------------------
  // Cheap collaboration: the client that has a kit loaded heartbeats
  // POST /api/kits/:id/presence every ~10 seconds. GET returns rows
  // seen within the last 60 seconds — that's the "editors right now"
  // list plus the kit's updated_at so clients can detect a save that
  // landed while they were viewing and prompt for a refresh.
  const PRESENCE_STALE_S = 60;

  app.post('/api/kits/:id/presence', async (req: any, res) => {
    const kitId = parseInt(req.params.id);
    if (!kitId) return res.status(400).json({ error: 'invalid kit id' });
    const email = req.user?.email;
    if (!email) return res.status(401).json({ error: 'sign in required' });
    // Cheap "first name" derivation from the email local-part when the
    // users row doesn't have one — banner reads "Alex is editing" not
    // "alex.smith@... is editing".
    let displayName = '';
    try {
      const row = await queryOne<{ first_name: string; last_name: string }>(
        `SELECT first_name, last_name FROM users WHERE email = $1`, [email]
      );
      displayName = (row?.first_name || '').trim() || String(email).split('@')[0].split('.')[0];
    } catch { displayName = String(email).split('@')[0].split('.')[0]; }
    try {
      await query(
        `INSERT INTO kit_presence (kit_id, user_email, user_name, last_seen)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (kit_id, user_email) DO UPDATE SET last_seen = now(), user_name = EXCLUDED.user_name`,
        [kitId, email, displayName]
      );
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Explicit "I'm no longer editing" ping. Not required for correctness
  // — the 60s TTL fills in — but makes the banner clear instantly when
  // an operator closes the kit.
  app.delete('/api/kits/:id/presence', async (req: any, res) => {
    const kitId = parseInt(req.params.id);
    if (!kitId) return res.status(400).json({ error: 'invalid kit id' });
    const email = req.user?.email;
    if (!email) return res.status(401).json({ error: 'sign in required' });
    try {
      await query(`DELETE FROM kit_presence WHERE kit_id = $1 AND user_email = $2`, [kitId, email]);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/kits/:id/presence', async (req: any, res) => {
    const kitId = parseInt(req.params.id);
    if (!kitId) return res.status(400).json({ error: 'invalid kit id' });
    try {
      const { rows: editors } = await query(
        `SELECT user_email, user_name, last_seen FROM kit_presence
          WHERE kit_id = $1 AND last_seen > now() - ($2::text || ' seconds')::interval
       ORDER BY last_seen DESC`,
        [kitId, String(PRESENCE_STALE_S)]
      );
      const kit = await queryOne<{ updated_at: string }>(
        `SELECT updated_at FROM kits WHERE id = $1`, [kitId]
      );
      res.json({
        updatedAt: kit?.updated_at || null,
        editors: (editors as any[]).map(r => ({
          email: r.user_email,
          name: r.user_name || String(r.user_email).split('@')[0],
          lastSeen: r.last_seen,
        })),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
