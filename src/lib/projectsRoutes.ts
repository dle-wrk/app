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
import { query, queryOne, exec } from './db';

export function registerProjectsRoutes(app: Express): void {
  // ---------------------------------------------------------------------------
  // Projects CRUD
  // ---------------------------------------------------------------------------
  app.get('/api/projects', async (_req, res) => {
    try {
      const { rows } = await query('SELECT * FROM projects ORDER BY id');
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
          `UPDATE projects SET description = $1, status = $2, start_date = $3, end_date = $4, assigned_team = $5, design_specs = $6 WHERE project_name = $7`,
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
    const sqlText = `UPDATE projects SET project_name = $1, description = $2, status = $3, start_date = $4, end_date = $5, assigned_team = $6, design_specs = $7 WHERE id = $8`;
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
  // Per-project BOM  (db_bom_project_<id>)
  // ---------------------------------------------------------------------------
  app.get('/api/projects/:id/bom', async (req, res) => {
    const projectId = parseInt(req.params.id);
    try {
      const { rows } = await query(`SELECT * FROM "db_bom_project_${projectId}"`);
      const mapped = rows.map((r: any) => ({
        stockCode: String(r.internal_stock_number || ''),
        quantity: parseInt(r.qty_per_unit || '0') || 1,
        designator: String(r.ref_des || ''),
        description: String(r.description || ''),
        comment: String(r.comment || ''),
        footprint: String(r.footprint || ''),
        libref: String(r.libref || ''),
      }));
      res.json(mapped);
    } catch (err: any) {
      // 42P01 = undefined_table: project simply has no BOM yet.
      if (err.code === '42P01') {
        return res.json([]);
      }
      res.status(500).json({ error: err.message });
    }
  });

  // Bulk upsert into this project's BOM. Creates the per-project table on
  // the fly (with ADD COLUMN IF NOT EXISTS for legacy schemas missing the
  // description/comment/footprint/libref columns) then upserts every item.
  // Also resets any downstream production_kits back to STAGING so the
  // manufacturing side has to re-review after a CAD-side change.
  app.post('/api/projects/:id/bom', async (req, res) => {
    const projectId = parseInt(req.params.id);
    const { items } = req.body; // items: [{ stockCode, quantity, designator, ... }]
    console.log(`[POST BOM] req received for project ${projectId}, items count: ${items ? items.length : 0}`);

    try {
      const tableName = `db_bom_project_${projectId}`;
      console.log(`[POST BOM] creating table if not exists "${tableName}"...`);
      await query(`CREATE TABLE IF NOT EXISTS "${tableName}" (
        project_name INTEGER,
        internal_stock_number TEXT PRIMARY KEY,
        qty_per_unit INTEGER,
        ref_des TEXT
      )`);
      console.log(`[POST BOM] table "${tableName}" created/checked successfully.`);

      const extraColumns = [
        { name: 'description', type: 'TEXT DEFAULT \'\'' },
        { name: 'comment', type: 'TEXT DEFAULT \'\'' },
        { name: 'footprint', type: 'TEXT DEFAULT \'\'' },
        { name: 'libref', type: 'TEXT DEFAULT \'\'' },
      ];

      for (const col of extraColumns) {
        console.log(`[POST BOM] ensuring column "${col.name}" exists on "${tableName}"...`);
        await query(`ALTER TABLE "${tableName}" ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`);
      }
      console.log(`[POST BOM] all extra columns checked.`);

      for (const item of items) {
        console.log(`[POST BOM] inserting/updating item ${item.stockCode} in "${tableName}"...`);
        await query(
          `INSERT INTO "${tableName}" (project_name, internal_stock_number, qty_per_unit, ref_des, description, comment, footprint, libref) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT(internal_stock_number) DO UPDATE SET
               qty_per_unit = EXCLUDED.qty_per_unit,
               ref_des = EXCLUDED.ref_des,
               description = EXCLUDED.description,
               comment = EXCLUDED.comment,
               footprint = EXCLUDED.footprint,
               libref = EXCLUDED.libref`,
          [projectId, item.stockCode, item.quantity, item.designator || '', item.description || '', item.comment || '', item.footprint || '', item.libref || '']
        );
      }
      console.log(`[POST BOM] items upsert complete.`);

      console.log(`[POST BOM] updating production_kits...`);
      await query(
        `UPDATE production_kits SET status = 'STAGING', lastUpdated = $1 WHERE projectId = $2`,
        [new Date().toISOString().split('T')[0], projectId]
      );
      console.log(`[POST BOM] production_kits updated successfully.`);

      res.json({ ok: true });
    } catch (err: any) {
      console.error('ERROR IN POST /api/projects/:id/bom:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------------------
  // Per-project Pick & Place  (pp_bom_project_<id>)
  // ---------------------------------------------------------------------------
  app.post('/api/projects/:id/pp', async (req, res) => {
    const projectId = parseInt(req.params.id);
    const { items } = req.body;

    try {
      const tableName = `pp_bom_project_${projectId}`;
      await query(`CREATE TABLE IF NOT EXISTS "${tableName}" (
        project_name INTEGER,
        stock_code TEXT PRIMARY KEY,
        quantity INTEGER
      )`).catch(() => {});

      const ppExtraColumns = [
        { name: 'comment', type: 'TEXT DEFAULT \'\'' },
        { name: 'description', type: 'TEXT DEFAULT \'\'' },
        { name: 'designator', type: 'TEXT DEFAULT \'\'' },
        { name: 'footprint', type: 'TEXT DEFAULT \'\'' },
        { name: 'libref', type: 'TEXT DEFAULT \'\'' },
      ];

      for (const col of ppExtraColumns) {
        await query(`ALTER TABLE "${tableName}" ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`).catch(() => {});
      }

      for (const item of items) {
        await query(
          `INSERT INTO "${tableName}" (project_name, stock_code, comment, description, designator, footprint, libref, quantity) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT(stock_code) DO UPDATE SET
               comment = EXCLUDED.comment,
               description = EXCLUDED.description,
               designator = EXCLUDED.designator,
               footprint = EXCLUDED.footprint,
               libref = EXCLUDED.libref,
               quantity = EXCLUDED.quantity`,
          [projectId, item.stockCode, item.comment || '', item.description || '', item.designator || '', item.footprint || '', item.libref || '', item.quantity]
        );
      }
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
      let allItems: any[] = [];
      for (const t of tables) {
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
