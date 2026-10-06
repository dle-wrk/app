// Projects surface extracted from server.ts. Owns the project catalogue
// (CRUD + soft-restore) plus the per-project BOM / Pick&Place tables and
// the top-level job_cards + aggregated bom-items / pp-items lookups the
// dashboard uses.
//
// Notable data-model quirks preserved verbatim:
//   - Per-project BOM tables are named `db_bom_project_<id>` and P&P tables
//     `pp_bom_project_<id>` — one table per project, not one shared table
//     keyed by project_id. Legacy from the pre-Postgres import. Delete cascades
//     drop those tables and any orphan job_cards; the mapper walks pg_class to
//     enumerate them for the aggregated /api/bom-items and /api/pp-items feeds.
//   - Project ids are allocated as MAX(id)+1 rather than a serial sequence, so
//     a freed id gets reused. The delete cascade cleans up the per-project
//     tables to stop the next project inheriting the previous one's rows.
//   - POST /api/projects has upsert-by-name semantics: sending a name that
//     already exists updates the existing row and returns 200; new names
//     insert and return 201. That's what the frontend "quick add" flow
//     depends on to avoid duplicate rows on a resubmit.
//   - Restore takes the full project snapshot the frontend logs at delete
//     time and INSERTs it back with ON CONFLICT DO UPDATE. It does NOT
//     restore the per-project BOM / P&P tables — those are gone.
//
// Dependencies deliberately narrow: only the shared db helpers.

import type { Express } from 'express';
import { pool, query, queryOne, exec } from './db';

// One BOM Manager line: a part and everything the BOM says about it.
export interface BomLine {
  stockCode: string;
  quantity: number;
  designator: string;
  description: string;
  comment: string;
  footprint: string;
  libref: string;
}

// Folds a per-project BOM table's rows into one line per stock code, in
// row order. A part can have several rows (a kit import writes one per
// designator): quantities add up, designators are joined, and distinct
// comments are kept. A row with no quantity counts as 1, as it always has
// in the BOM Manager.
export function foldBomRows(rows: any[]): BomLine[] {
  const lines = new Map<string, BomLine & { comments: string[] }>();
  for (const r of rows) {
    const stockCode = String(r.internal_stock_number ?? '').trim();
    if (!stockCode) continue;
    const quantity = parseInt(String(r.qty_per_unit ?? '0'), 10) || 1;
    const designator = String(r.ref_des ?? '').trim();
    const comment = String(r.comment ?? '').trim();
    const line = lines.get(stockCode);
    if (!line) {
      lines.set(stockCode, {
        stockCode, quantity, designator,
        description: String(r.description ?? '').trim(),
        comment: '', comments: comment ? [comment] : [],
        footprint: String(r.footprint ?? '').trim(),
        libref: String(r.libref ?? '').trim(),
      });
      continue;
    }
    line.quantity += quantity;
    if (designator) line.designator = line.designator ? `${line.designator}, ${designator}` : designator;
    if (comment && !line.comments.includes(comment)) line.comments.push(comment);
    if (!line.description) line.description = String(r.description ?? '').trim();
    if (!line.footprint) line.footprint = String(r.footprint ?? '').trim();
    if (!line.libref) line.libref = String(r.libref ?? '').trim();
  }
  return [...lines.values()].map(({ comments, ...line }) => ({ ...line, comment: comments.join('; ') }));
}

// Validates the lines the BOM Manager sends. Every line needs a stock code,
// used once, and a whole-number quantity.
export function parseBomLines(items: unknown): { lines: BomLine[] } | { error: string } {
  if (!Array.isArray(items)) return { error: 'items must be a list' };
  const lines: BomLine[] = [];
  const seen = new Set<string>();
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
  for (const item of items as any[]) {
    const stockCode = text(item?.stockCode);
    if (!stockCode) return { error: 'every line needs a stock code' };
    if (stockCode.length > 200) return { error: `stock code too long: ${stockCode.slice(0, 40)}…` };
    if (seen.has(stockCode)) return { error: `${stockCode} is listed more than once` };
    seen.add(stockCode);
    const quantity = Number(item?.quantity);
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 1_000_000) {
      return { error: `${stockCode}: quantity must be a whole number` };
    }
    lines.push({
      stockCode, quantity,
      designator: text(item?.designator),
      description: text(item?.description),
      comment: text(item?.comment),
      footprint: text(item?.footprint),
      libref: text(item?.libref),
    });
  }
  return { lines };
}

export function registerProjectsRoutes(app: Express): void {
  // ---------------------------------------------------------------------------
  // Projects CRUD
  // ---------------------------------------------------------------------------
  app.get('/api/projects', async (_req, res) => {
    try {
      // last_activity_at folds a kit save into the "when was this
      // project last touched" answer — an operator who resaves a kit
      // for TCU06 has meaningfully edited the project's plan even if
      // the projects row itself wasn't updated.
      const { rows } = await query(`
        SELECT p.*,
               GREATEST(
                 p.updated_at,
                 (SELECT MAX(updated_at) FROM kits WHERE project_id = p.id::int)
               ) AS last_activity_at
          FROM projects p
      ORDER BY p.id
      `);
      const mapped = rows.map((r: any) => ({
        id: parseInt(r.id) || 0,
        projectName: r.project_name,
        description: r.description,
        status: r.status,
        createdDate: r.created_date,
        startDate: r.start_date,
        endDate: r.end_date,
        assignedTeam: r.assigned_team,
        designSpecs: r.design_specs,
        updatedAt: r.updated_at,
        lastActivityAt: r.last_activity_at,
      }));
      res.json(mapped);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Upsert-by-name: an existing project with the same name is updated in
  // place (200); a new name inserts (201). The frontend quick-add relies
  // on this — a double-submit doesn't create duplicates.
  app.post('/api/projects', async (req, res) => {
    const { projectName, description, status, createdDate, startDate, endDate, assignedTeam, designSpecs } = req.body;
    if (!projectName) return res.status(400).json({ error: 'projectName is required' });

    try {
      const existing = await queryOne(`SELECT * FROM projects WHERE project_name = $1`, [projectName]);
      let row: any;
      let isNew = false;

      if (existing) {
        await query(
          `UPDATE projects SET description = $1, status = $2, start_date = $3, end_date = $4, assigned_team = $5, design_specs = $6, updated_at = now() WHERE project_name = $7`,
          [description || '', status || 'Active', startDate || null, endDate || null, assignedTeam || '', designSpecs || '', projectName]
        );
        row = existing;
      } else {
        // MAX(id)+1 not a serial. See file header for the rationale.
        const maxId = await queryOne(`SELECT COALESCE(MAX(id::integer), 0) + 1 as next_id FROM projects`, []);
        const nextId = maxId?.next_id || 1;
        await query(
          `INSERT INTO projects (id, project_name, description, status, created_date, start_date, end_date, assigned_team, design_specs) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [nextId, projectName, description || '', status || 'Active', createdDate || new Date().toISOString().split('T')[0], startDate || null, endDate || null, assignedTeam || '', designSpecs || '']
        );
        row = {
          id: nextId,
          project_name: projectName,
          description: description || '',
          status: status || 'Active',
          created_date: createdDate || new Date().toISOString().split('T')[0],
          start_date: startDate || null,
          end_date: endDate || null,
          assigned_team: assignedTeam || '',
          design_specs: designSpecs || '',
        };
        isNew = true;
      }

      const mapped = {
        id: parseInt(row?.id || '0'),
        projectName: row?.project_name,
        description: row?.description,
        status: row?.status,
        createdDate: row?.created_date,
        startDate: row?.start_date,
        endDate: row?.end_date,
        assignedTeam: row?.assigned_team,
        designSpecs: row?.design_specs,
      };
      res.status(isNew ? 201 : 200).json(mapped);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/projects/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const { projectName, description, status, startDate, endDate, assignedTeam, designSpecs } = req.body;
    const sqlText = `UPDATE projects SET project_name = $1, description = $2, status = $3, start_date = $4, end_date = $5, assigned_team = $6, design_specs = $7, updated_at = now() WHERE id = $8`;
    try {
      const { rowCount } = await query(sqlText, [projectName, description, status, startDate, endDate, assignedTeam, designSpecs, id]);
      if (rowCount === 0) return res.status(404).json({ error: 'project not found' });
      const row = await queryOne(`SELECT * FROM projects WHERE id = $1`, [id]);
      const mapped = {
        id: parseInt(row?.id || '0'),
        projectName: row?.project_name,
        description: row?.description,
        status: row?.status,
        createdDate: row?.created_date,
        startDate: row?.start_date,
        endDate: row?.end_date,
        assignedTeam: row?.assigned_team,
        designSpecs: row?.design_specs,
      };
      res.json(mapped);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete cascade: drop this project's BOM/P&P tables and its job cards.
  // Ids are allocated as MAX(id)+1, so a freed id gets reused — orphaned
  // data would silently attach itself to the next project with the same id.
  app.delete('/api/projects/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      const { rowCount } = await query(`DELETE FROM projects WHERE id = $1`, [id]);
      if (rowCount === 0) return res.status(404).json({ error: 'project not found' });
      await exec(`DROP TABLE IF EXISTS "db_bom_project_${id}"`).catch(() => {});
      await exec(`DROP TABLE IF EXISTS "pp_bom_project_${id}"`).catch(() => {});
      await query(`DELETE FROM job_cards WHERE project_id = $1`, [id]).catch(() => {});
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Undo for the delete above. Restores the project row from the snapshot
  // the frontend logs at delete time; does NOT reinstate per-project BOM /
  // P&P tables — those are gone once the delete cascade fires.
  app.post('/api/projects/restore/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const projectData = req.body;
    console.log(`[RESTORE PROJECT] request to restore project: ${id}`);

    try {
      if (!projectData || typeof projectData !== 'object') {
        return res.status(400).json({ error: 'Invalid project data for restore' });
      }

      const {
        projectName,
        description,
        status,
        createdDate,
        startDate,
        endDate,
        assignedTeam,
        designSpecs,
      } = projectData;

      const sqlText = `
        INSERT INTO projects (id, project_name, description, status, created_date, start_date, end_date, assigned_team, design_specs)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (id) DO UPDATE SET
          project_name = EXCLUDED.project_name,
          description = EXCLUDED.description,
          status = EXCLUDED.status,
          created_date = EXCLUDED.created_date,
          start_date = EXCLUDED.start_date,
          end_date = EXCLUDED.end_date,
          assigned_team = EXCLUDED.assigned_team,
          design_specs = EXCLUDED.design_specs
      `;

      const { rowCount } = await query(sqlText, [
        id,
        projectName || 'Untitled Project',
        description || '',
        status || 'Active',
        createdDate || new Date().toISOString().split('T')[0],
        startDate || null,
        endDate || null,
        assignedTeam || '',
        designSpecs || '',
      ]);

      if (rowCount === 0) {
        console.warn(`[RESTORE PROJECT] failed to restore project: ${id}`);
        return res.status(500).json({ error: 'Failed to restore project' });
      }

      const row = await queryOne(`SELECT * FROM projects WHERE id = $1`, [id]);
      console.log(`[RESTORE PROJECT] successfully restored project: ${id}`);
      res.json({ success: true, message: `Project ${id} restored successfully`, project: row });
    } catch (err: any) {
      console.error(`[RESTORE PROJECT] ERROR restoring project:`, err.message);
      res.status(500).json({ error: 'Failed to restore project', details: err.message });
    }
  });

  // ---------------------------------------------------------------------------
  // Per-project BOM  (db_bom_project_<id>) — the BOM Manager's data
  // ---------------------------------------------------------------------------
  // The BOM Manager shows one line per stock code. These tables have no
  // unique key on the stock code (server boot drops it on purpose, see
  // server.ts: a kit import keeps one row per designator), so the rows for
  // a part are folded into one line here, and the save below compares
  // against the same fold to tell an unchanged line from an edited one.
  app.get('/api/projects/:id/bom', async (req, res) => {
    const projectId = parseInt(req.params.id);
    try {
      const { rows } = await query(`SELECT * FROM "db_bom_project_${projectId}" ORDER BY ctid`);
      res.json(foldBomRows(rows));
    } catch (err: any) {
      // 42P01 = undefined_table: project simply has no BOM yet.
      if (err.code === '42P01') {
        return res.json([]);
      }
      res.status(500).json({ error: err.message });
    }
  });

  // Save the BOM Manager's lines. With `replace: true` (what the BOM
  // Manager sends) the project's BOM becomes exactly these lines: new parts
  // are added, edited ones rewritten and parts no longer listed removed.
  // A part whose line is unchanged keeps its rows exactly as they were,
  // so a kit import's per-designator rows survive a save that didn't
  // touch them.
  //
  // This used to upsert with ON CONFLICT (internal_stock_number), which
  // needs a unique key these tables no longer have, so every save failed
  // and nothing was written. Plain deletes and inserts in one transaction
  // need no key.
  //
  // Anything that changed also resets the project's production kits to
  // STAGING, so the manufacturing side re-reviews after a BOM change.
  app.post('/api/projects/:id/bom', async (req, res) => {
    const projectId = parseInt(req.params.id);
    const parsed = parseBomLines(req.body?.items);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    const replace = req.body?.replace === true;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const project = await client.query(`SELECT id FROM projects WHERE id::int = $1`, [projectId]);
      if (project.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'project not found' });
      }

      const table = `db_bom_project_${projectId}`;
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
      for (const col of ['description', 'comment', 'footprint', 'libref']) {
        await client.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS ${col} TEXT DEFAULT ''`);
      }

      const { rows } = await client.query(`SELECT * FROM "${table}" ORDER BY ctid`);
      const current = new Map(foldBomRows(rows).map((l) => [l.stockCode, l]));
      const wanted = new Set(parsed.lines.map((l) => l.stockCode));
      let added = 0, updated = 0, removed = 0, unchanged = 0;

      for (const line of parsed.lines) {
        const before = current.get(line.stockCode);
        if (before && before.quantity === line.quantity && before.designator === line.designator && before.comment === line.comment) {
          unchanged += 1;
          continue;
        }
        if (before) {
          await client.query(`DELETE FROM "${table}" WHERE TRIM(internal_stock_number) = $1`, [line.stockCode]);
          updated += 1;
        } else {
          added += 1;
        }
        await client.query(
          `INSERT INTO "${table}" (project_name, internal_stock_number, qty_per_unit, ref_des, description, comment, footprint, libref)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [projectId, line.stockCode, line.quantity, line.designator, line.description || before?.description || '', line.comment,
            line.footprint || before?.footprint || '', line.libref || before?.libref || '']
        );
      }
      if (replace) {
        for (const code of current.keys()) {
          if (wanted.has(code)) continue;
          await client.query(`DELETE FROM "${table}" WHERE TRIM(internal_stock_number) = $1`, [code]);
          removed += 1;
        }
      }

      if (added + updated + removed > 0) {
        await client.query(
          `UPDATE production_kits SET status = 'STAGING', lastUpdated = $1 WHERE projectId = $2`,
          [new Date().toISOString().split('T')[0], projectId]
        );
        await client.query(`UPDATE projects SET updated_at = now() WHERE id::int = $1`, [projectId]);
      }
      await client.query('COMMIT');
      res.json({ ok: true, added, updated, removed, unchanged });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('ERROR IN POST /api/projects/:id/bom:', err.message);
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  // ---------------------------------------------------------------------------
  // Per-project Pick & Place  (pp_bom_project_<id>)
  // ---------------------------------------------------------------------------
  // Written by the BOM Manager alongside the BOM, one row per stock code.
  // With `replace: true` the list becomes exactly the lines sent, so a part
  // removed from the BOM leaves Pick & Place too. Deletes and inserts in
  // one transaction rather than ON CONFLICT, for the same reason as above.
  app.post('/api/projects/:id/pp', async (req, res) => {
    const projectId = parseInt(req.params.id);
    const parsed = parseBomLines(req.body?.items);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    const replace = req.body?.replace === true;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const project = await client.query(`SELECT id FROM projects WHERE id::int = $1`, [projectId]);
      if (project.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'project not found' });
      }

      const table = `pp_bom_project_${projectId}`;
      await client.query(`CREATE TABLE IF NOT EXISTS "${table}" (
        project_name INTEGER,
        stock_code TEXT PRIMARY KEY,
        quantity INTEGER
      )`);
      for (const col of ['comment', 'description', 'designator', 'footprint', 'libref']) {
        await client.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS ${col} TEXT DEFAULT ''`);
      }

      if (replace) {
        await client.query(`DELETE FROM "${table}"`);
      } else if (parsed.lines.length) {
        await client.query(`DELETE FROM "${table}" WHERE stock_code = ANY($1::text[])`, [parsed.lines.map((l) => l.stockCode)]);
      }
      for (const line of parsed.lines) {
        await client.query(
          `INSERT INTO "${table}" (project_name, stock_code, comment, description, designator, footprint, libref, quantity)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [projectId, line.stockCode, line.comment, line.description, line.designator, line.footprint, line.libref, line.quantity]
        );
      }
      await client.query('COMMIT');
      res.json({ ok: true, count: parsed.lines.length });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  // ---------------------------------------------------------------------------
  // Job cards (top-level, not per-project tables)
  // ---------------------------------------------------------------------------
  app.get('/api/job-cards', async (_req, res) => {
    try {
      const { rows } = await query('SELECT * FROM job_cards ORDER BY created_at DESC');
      const mapped = rows.map((r: any) => ({
        id: r.id,
        projectId: r.project_id,
        buildQty: r.build_qty,
        status: r.status,
        createdAt: r.created_at,
        assignedTeam: r.assigned_team,
      }));
      res.json(mapped);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/job-cards', async (req, res) => {
    const { projectId, buildQty, status } = req.body;
    const sqlText = `INSERT INTO job_cards (project_id, build_qty, status, created_at) VALUES ($1, $2, $3, $4)`;
    try {
      await query(sqlText, [projectId, buildQty || 0, status || 'Pending', new Date().toISOString()]);
      res.status(201).json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------------------
  // Aggregated BOM / P&P feeds. Both walk pg_class to enumerate every
  // per-project table then merge the rows. Columns are aliased through a
  // handful of legacy names (internal_stock_number vs stock_code vs
  // StockCode etc) because tables imported from earlier ETL passes may
  // still use the pre-normalised column names.
  // ---------------------------------------------------------------------------
  app.get('/api/bom-items', async (_req, res) => {
    try {
      const { rows: tables } = await query<{ tablename: string }>(
        `SELECT c.relname as tablename FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'db_bom%'`
      );
      // BOM Manager and P&P Kit Booking must show the same rows per
      // project — this endpoint was walking every db_bom* table including
      // legacy per-model duplicates (db_bom_tcu06 etc.) that the kit-
      // booking audit deliberately ignores, so BOM Manager showed rows
      // P&P never counts. Match the audit's table set exactly here: the
      // three universal legacy tables auditKitStock reads (db_bom,
      // db_bom_ncu04, db_bom_loradongle) plus every db_bom_project_<N>
      // per-project table. Anything else stays in the database but is
      // no longer surfaced through this feed.
      const eligible = tables.filter(t =>
        t.tablename === 'db_bom' ||
        t.tablename === 'db_bom_ncu04' ||
        t.tablename === 'db_bom_loradongle' ||
        /^db_bom_project_\d+$/.test(t.tablename)
      );
      let allItems: any[] = [];
      for (const t of eligible) {
        const { rows } = await query(`SELECT * FROM "${t.tablename}"`);
        const mapped = rows.map((r: any) => {
          const stockCode = String(r.internal_stock_number || r.stock_code || r.StockCode || '');
          const designator = String(r.ref_des || r.designator || r.Designator || '');
          return {
            id: `BOM-${t.tablename}-${stockCode}-${designator}`,
            projectId: parseInt(r.project_name || r.projectId || r.ProjectId) || 1,
            stockCode,
            comment: String(r.comment || r.Comment || ''),
            description: String(r.description || r.Description || ''),
            designator,
            footprint: String(r.footprint || r.Footprint || ''),
            libref: String(r.libref || r.LibRef || ''),
            quantity: parseInt(r.qty_per_unit || r.quantity || r.Quantity) || 1,
          };
        });
        allItems = allItems.concat(mapped);
      }
      res.json(allItems);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/pp-items', async (_req, res) => {
    try {
      const { rows: tables } = await query<{ tablename: string }>(
        `SELECT c.relname as tablename FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'pp_bom%'`
      );
      let allItems: any[] = [];
      for (const t of tables) {
        const { rows } = await query(`SELECT * FROM "${t.tablename}"`);
        const mapped = rows.map((r: any, idx: number) => {
          const stockCode = String(r.stock_code || r.internal_stock_number || r.StockCode || '');
          return {
            id: `PP-${t.tablename}-${idx}`,
            projectId: parseInt(r.project_name || r.projectId || r.ProjectId) || 1,
            stockCode,
            comment: String(r.comment || r.Comment || ''),
            description: String(r.description || r.Description || ''),
            designator: String(r.designator || r.ref_des || r.Designator || ''),
            footprint: String(r.footprint || r.Footprint || ''),
            libref: String(r.libref || r.LibRef || ''),
            quantity: parseInt(r.quantity || r.qty_per_unit || r.Quantity) || 1,
          };
        });
        allItems = allItems.concat(mapped);
      }
      res.json(allItems);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
