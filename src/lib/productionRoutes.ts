// Production surface extracted from server.ts. Covers Phase 3 (production
// jobs, work orders, QC checkpoints, defect tracking, order fulfillment,
// production metrics) plus the finished-goods catalogue, the enhanced
// production-kits list, the older build-jobs table, and the kit-booking
// validate/execute flow that atomically deducts stock against a project BOM.
//
// Notes for future maintainers:
//   - `production_products` and `production_kits`/`build_jobs` predate the
//     Phase 3 tables and read from different columns; they are grouped here
//     because everything under `/api/production-*`, `/api/work-orders`,
//     `/api/qc-checkpoints`, `/api/job-allocations`, `/api/order-fulfillment`,
//     `/api/build-jobs`, and `/api/kit-booking/*` belongs to the same domain.
//   - Route registration order inside registerProductionRoutes matches the
//     original server.ts order to preserve Express matching precedence for
//     any parametric collisions (e.g. `/api/production-jobs?status=` vs id
//     lookups on adjacent surfaces).
//   - Kit-booking's execute path writes to `transactions` and `job_cards`
//     (not production-suffix tables) — kept here because the flow originates
//     in kit booking rather than in inventory transactions.
//   - `ensureProductionCostsSchema` is exported and still called from the
//     boot bootstrap in server.ts. Do not move that call into this module's
//     register step: schema creation runs once, before any router is wired.

import type { Express } from 'express';
import { z } from 'zod';
import { pool, query, queryOne, exec } from './db';
import { requireAdmin } from './authRoutes';

// --- Finished-goods catalogue --------------------------------------------
// Seeded once from Tracklab_Production_Costs_2026-04-30.xlsx; editable
// in-app thereafter. Ties into the ERP: model_number doubles as the part
// number used on invoices/sales orders, selling_price is the finished-goods
// price, and (selling - cost) is the unit margin/COGS view.
const mapProductionProduct = (r: any) => {
  const cost = r.production_cost === null ? null : Number(r.production_cost);
  const price = r.selling_price === null ? null : Number(r.selling_price);
  const margin = cost !== null && price !== null ? Math.round((price - cost) * 100) / 100 : null;
  const marginPct = margin !== null && price ? Math.round((margin / price) * 1000) / 10 : null;
  return {
    id: r.id,
    modelNumber: r.model_number,
    description: r.description,
    category: r.category,
    productionCost: cost,
    sellingPrice: price,
    currency: r.currency,
    notes: r.notes,
    margin,
    marginPct,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
};

const ProductionProductSchema = z.object({
  modelNumber: z.string().min(1),
  description: z.string().optional(),
  category: z.string().optional(),
  productionCost: z.number().nullable().optional(),
  sellingPrice: z.number().nullable().optional(),
  currency: z.string().optional(),
  notes: z.string().optional(),
});

// [model, description, category, productionCost|null, sellingPrice|null]
// Selling prices come straight from the workbook's Ordering Calculator / model price lists.
// Production costs are ONLY filled where the sheet gives an explicit total cost paired with the
// selling price — the rest are left null (unknown) rather than fabricated, to be filled in-app.
const PRODUCTION_PRODUCTS_SEED: Array<[string, string, string, number | null, number | null]> = [
  ['TCU-001-SAT', '24V Self Powered, Single Axis Tracker', 'TCU', null, 8827.89],
  ['TCU-002-SAT', 'AC Powered, Single Axis Tracker', 'TCU', null, 9998.93],
  ['TCU-003-SAT', '300-1500Vdc String Powered, Single Axis Tracker', 'TCU', null, 10598.81],
  ['NCU-004-SANC', 'AC Powered Unit AC-DC 5V supply', 'NCU', null, 16656],
  ['NCU-005-SANC', 'DC Powered Unit DC-DC 5V supply', 'NCU', null, null],
  ['NCU-SYS-001', 'NCU System Cabinet 220Vac to 24Vdc 2.1A', 'NCU System', 25024.13, 33392.26],
  ['NCU-SYS-002', 'NCU System Cabinet Self PV Powered 48Vdc', 'NCU System', null, 34438.60],
  ['DON-001-SATD', 'Wireless LoRa Dongle (internal antenna)', 'Dongle', 1817.05, 3634.10],
  ['DON-002-SATD', 'Wireless LoRa Dongle (external antenna)', 'Dongle', 1817.05, 3634.10],
  ['DON-003-SATD', 'Wireless BLE Dongle', 'Dongle', null, 520.40],
  ['PROG-001-SATP', 'RS485 TCU Programming Cable', 'Programming', 390, 780],
  ['PWR-PCK-001', 'Power Pack Battery Box', 'Power', 2127.43, 4254.86],
  ['WIR-RGC-001', 'Coax RF Cable RG58 5m long extension', 'Accessory', null, 192.50],
  ['CAB-FLY-001', 'USB-C to USB-C cable', 'Accessory', null, 79],
  ['CAB-FLY-002', 'USB-C to USB-A cable', 'Accessory', null, 79],
  ['CAB-FLY-003', 'Antenna Adapter Cable', 'Accessory', null, 80],
  ['SEN-ANE-001', 'Wind Sensor Pulse Type (PCE-WS P)', 'Accessory', null, 2503.31],
  ['ANT-LORA-NCU', 'NCU High Gain LoRa Antenna 433MHz', 'Accessory', null, 260],
  ['ANT-TCU-001', 'TCU Antenna Cable', 'Accessory', null, 100],
];

export async function ensureProductionCostsSchema() {
  await exec(`CREATE TABLE IF NOT EXISTS production_products (
    id SERIAL PRIMARY KEY,
    model_number TEXT UNIQUE NOT NULL,
    description TEXT,
    category TEXT,
    production_cost NUMERIC(14,2),
    selling_price NUMERIC(14,2),
    currency TEXT DEFAULT 'ZAR',
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  const count = await queryOne<{ count: string }>(`SELECT COUNT(*) as count FROM production_products`);
  if (parseInt(count?.count || '0', 10) === 0) {
    for (const [model, desc, category, cost, price] of PRODUCTION_PRODUCTS_SEED) {
      await query(
        `INSERT INTO production_products (model_number, description, category, production_cost, selling_price)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (model_number) DO NOTHING`,
        [model, desc, category, cost, price]
      );
    }
    console.log(`Seeded ${PRODUCTION_PRODUCTS_SEED.length} production products.`);
  }
}

// --- Kit booking helper ---------------------------------------------------
// Walks every db_bom_* table matching the project, aggregates BOM lines
// by stock code, then compares required qty vs on-hand (falling through
// to alternative parts if a primary is short). Only surfaces navigable
// supplier URLs — the weblink_N columns hold plenty of placeholder junk
// ("N/A", " ", partial paths) that used to render as broken sourcing buttons.
async function auditKitStock(projectId: number, buildQty: number, opts?: { excludeKitId?: number | null }) {
  const excludeKitId = opts?.excludeKitId ?? null;
  // Load reservations up front and treat them as unavailable stock.
  // Passing excludeKitId lets an operator editing an already-saved kit
  // see its own reservations back (subtracting them would double-count
  // — the qty is already committed to this same kit).
  const reservationsRes = excludeKitId
    ? await query<{ allocated_code: string; reserved_qty: string }>(
        `SELECT allocated_code, SUM(qty)::int AS reserved_qty FROM kit_reservations WHERE kit_id <> $1 GROUP BY allocated_code`,
        [excludeKitId]
      )
    : await query<{ allocated_code: string; reserved_qty: string }>(
        `SELECT allocated_code, SUM(qty)::int AS reserved_qty FROM kit_reservations GROUP BY allocated_code`
      );
  const reservedByCode = new Map<string, number>();
  for (const r of reservationsRes.rows) reservedByCode.set(r.allocated_code, parseInt(r.reserved_qty as any) || 0);
  const availableFor = (code: string, rawStock: number) => Math.max(0, rawStock - (reservedByCode.get(code) || 0));

  const { rows: tables } = await query<{ tablename: string }>(`SELECT c.relname as tablename FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'db_bom%'`);

  // Optimize: Only query legacy tables or the project's specific table
  const targetTables = tables.filter(t =>
    t.tablename === 'db_bom' ||
    t.tablename === 'db_bom_ncu04' ||
    t.tablename === 'db_bom_loradongle' ||
    t.tablename === `db_bom_project_${projectId}`
  );

  const aggregatedBOM = new Map<string, { quantity: number; description: string; comment: string; designator: string }>();

  for (const t of targetTables) {
    const { rows } = await query(`SELECT * FROM "${t.tablename}"`);
    for (const r of rows) {
      const rowProjectId = parseInt(r.project_name || r.projectId || r.ProjectId) || 1;
      if (rowProjectId === projectId) {
        const stockCode = String(r.internal_stock_number || r.stock_code || r.StockCode || '');
        const qty = parseInt(r.qty_per_unit || r.quantity || r.Quantity) || 1;
        const desc = String(r.description || r.Description || '');
        const comment = String(r.comment || r.Comment || '');
        const designator = String(r.ref_des || r.designator || r.Designator || '');

        if (aggregatedBOM.has(stockCode)) {
          const existing = aggregatedBOM.get(stockCode)!;
          existing.quantity += qty;
          if (designator) {
            existing.designator = existing.designator ? `${existing.designator}, ${designator}` : designator;
          }
        } else {
          aggregatedBOM.set(stockCode, { quantity: qty, description: desc, comment, designator });
        }
      }
    }
  }

  const auditResults: any[] = [];
  for (const [stockCode, bomInfo] of aggregatedBOM.entries()) {
    const qtyRequired = bomInfo.quantity * buildQty;
    const item = await queryOne(`SELECT * FROM inventory WHERE serial_number = $1`, [stockCode]);
    const rawStock = item ? (parseInt(item.stock || '0') || 0) : 0;
    let qtyOnHand = availableFor(stockCode, rawStock);
    let resolvedPartNumber = stockCode;
    let usedAlternative = false;

    if (qtyOnHand < qtyRequired) {
      const alternatives = await query(`SELECT alternative_part_number FROM alternative_components WHERE primary_part_number = $1`, [stockCode]);
      for (const alt of alternatives.rows as any[]) {
        const altItem = await queryOne(`SELECT * FROM inventory WHERE serial_number = $1`, [alt.alternative_part_number]);
        const altRaw = altItem ? (parseInt(altItem.stock || '0') || 0) : 0;
        const altAvail = availableFor(alt.alternative_part_number, altRaw);
        if (altAvail >= qtyRequired) {
          qtyOnHand = altAvail;
          resolvedPartNumber = alt.alternative_part_number;
          usedAlternative = true;
          break;
        }
      }
    }

    const shortageQty = Math.max(0, qtyRequired - qtyOnHand);
    const reservedQty = reservedByCode.get(resolvedPartNumber) || 0;
    const rawLinks = item ? [item.weblink_1, item.weblink_2, item.weblink_3, item.weblink_4, item.weblink_5] : [];
    const supplierLinks = rawLinks
      .map((v: any) => typeof v === 'string' ? v.trim() : '')
      .map((v: string) => v && !/^https?:\/\//i.test(v) && /^[\w-]+(\.[\w-]+)+/.test(v) ? `https://${v}` : v)
      .filter((v: string) => /^https?:\/\/\S+\.\S+/.test(v));

    // Manufacturer part number fallback for the Sourcing column: pick
    // the first non-empty man_pn_* column. Sourcing renders a Google
    // search link on that string when no supplier weblinks are present,
    // so a row is never a completely dead "No links".
    const mfnCandidates = item ? [item.man_pn_1, item.man_pn_2, item.man_pn_3, item.man_pn_4, item.man_pn_5] : [];
    const mfn = mfnCandidates.map(v => typeof v === 'string' ? v.trim() : '')
      .find(v => v && !/^n\/?a$/i.test(v)) || '';

    auditResults.push({
      component_id: stockCode,
      resolved_part_number: resolvedPartNumber,
      used_alternative: usedAlternative,
      qty_required: qtyRequired,
      qty_on_hand: qtyOnHand,
      // The reservation slice already subtracted from qty_on_hand — this
      // field is surfaced so the client can render "−N reserved" as an
      // explanatory hint without doing its own math.
      reserved_qty: reservedQty,
      shortage_qty: shortageQty,
      description: item?.description || bomInfo.description,
      comment: item?.comment || bomInfo.comment,
      designator: bomInfo.designator,
      supplier_links: supplierLinks,
      manufacturer_part_number: mfn,
      // Free-text colour marker (mainly LEDs). Only populated when
      // the inventory row carries a value; empty string otherwise so
      // clients can conditionally render.
      color: String(item?.color || '').trim(),
    });
  }

  return auditResults;
}

export function registerProductionRoutes(app: Express): void {
  // --- Production products (finished-goods catalogue) --------------------
  app.get('/api/production-products', async (_req, res) => {
    try {
      const { rows } = await query(`SELECT * FROM production_products ORDER BY category NULLS LAST, model_number`);
      res.json(rows.map(mapProductionProduct));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/production-products', async (req, res) => {
    const parsed = ProductionProductSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid product payload', details: parsed.error.flatten() });
    const b = parsed.data;
    try {
      const row = await queryOne(
        `INSERT INTO production_products (model_number, description, category, production_cost, selling_price, currency, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [b.modelNumber, b.description || null, b.category || null, b.productionCost ?? null, b.sellingPrice ?? null, b.currency || 'ZAR', b.notes || null]
      );
      res.status(201).json(mapProductionProduct(row));
    } catch (err: any) {
      if (String(err.message).includes('duplicate key')) return res.status(400).json({ error: `Model number "${b.modelNumber}" already exists.` });
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/production-products/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const parsed = ProductionProductSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid product payload', details: parsed.error.flatten() });
    const b = parsed.data;
    try {
      const row = await queryOne(
        `UPDATE production_products SET
           model_number = COALESCE($1, model_number),
           description = COALESCE($2, description),
           category = COALESCE($3, category),
           production_cost = $4,
           selling_price = $5,
           currency = COALESCE($6, currency),
           notes = COALESCE($7, notes),
           updated_at = CURRENT_TIMESTAMP
         WHERE id = $8 RETURNING *`,
        [b.modelNumber ?? null, b.description ?? null, b.category ?? null, b.productionCost ?? null, b.sellingPrice ?? null, b.currency ?? null, b.notes ?? null, id]
      );
      if (!row) return res.status(404).json({ error: 'product not found' });
      res.json(mapProductionProduct(row));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/production-products/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      const { rowCount } = await query(`DELETE FROM production_products WHERE id = $1`, [id]);
      if (rowCount === 0) return res.status(404).json({ error: 'product not found' });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Production kits (legacy list) -------------------------------------
  app.get('/api/production-kits', async (_req, res) => {
    const { rows } = await query('SELECT * FROM production_kits ORDER BY lastUpdated DESC');
    res.json(rows);
  });

  app.post('/api/production-kits', async (req, res) => {
    const kit = req.body;
    const sqlText = `INSERT INTO production_kits (kitId, skuReference, status, qtyAvailable, assemblyLine, lastUpdated, projectId)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT(kitId) DO UPDATE SET
        skuReference = EXCLUDED.skuReference,
        status = EXCLUDED.status,
        qtyAvailable = EXCLUDED.qtyAvailable,
        assemblyLine = EXCLUDED.assemblyLine,
        lastUpdated = EXCLUDED.lastUpdated,
        projectId = EXCLUDED.projectId`;
    try {
      await query(sqlText, [kit.kitId, kit.skuReference, kit.status, kit.qtyAvailable, kit.assemblyLine, kit.lastUpdated, kit.projectId]);
      res.status(201).json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Build jobs (legacy) -----------------------------------------------
  app.get('/api/build-jobs', async (_req, res) => {
    try {
      const { rows } = await query('SELECT * FROM build_jobs ORDER BY id');
      res.json(rows.map((row: any) => ({
        id: row.id,
        clientOrderId: row.client_order_id,
        jobNumber: row.job_number,
        status: row.status,
        buildQty: row.build_qty,
        startDate: row.start_date,
        endDate: row.end_date,
        assignedTeam: row.assigned_team,
        notes: row.notes,
        createdAt: row.created_at
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/build-jobs', async (req, res) => {
    const { clientOrderId, jobNumber, status, buildQty, startDate, endDate, assignedTeam, notes } = req.body;
    if (!jobNumber) return res.status(400).json({ error: 'jobNumber is required' });

    try {
      const row = await queryOne(`INSERT INTO build_jobs (client_order_id, job_number, status, build_qty, start_date, end_date, assigned_team, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [clientOrderId || null, jobNumber, status || 'PLANNED', buildQty || 1, startDate || null, endDate || null, assignedTeam || null, notes || null]);
      res.status(201).json({
        id: row?.id,
        clientOrderId: row?.client_order_id,
        jobNumber: row?.job_number,
        status: row?.status,
        buildQty: row?.build_qty,
        startDate: row?.start_date,
        endDate: row?.end_date,
        assignedTeam: row?.assigned_team,
        notes: row?.notes,
        createdAt: row?.created_at
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/build-jobs/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const { clientOrderId, jobNumber, status, buildQty, startDate, endDate, assignedTeam, notes } = req.body;
    try {
      const row = await queryOne(`UPDATE build_jobs SET
        client_order_id = COALESCE($1, client_order_id),
        job_number = COALESCE($2, job_number),
        status = COALESCE($3, status),
        build_qty = COALESCE($4, build_qty),
        start_date = COALESCE($5, start_date),
        end_date = COALESCE($6, end_date),
        assigned_team = COALESCE($7, assigned_team),
        notes = COALESCE($8, notes)
        WHERE id = $9 RETURNING *`,
        [clientOrderId ?? null, jobNumber ?? null, status ?? null, buildQty ?? null, startDate ?? null, endDate ?? null, assignedTeam ?? null, notes ?? null, id]);
      if (!row) return res.status(404).json({ error: 'build job not found' });
      res.json({
        id: row.id,
        clientOrderId: row.client_order_id,
        jobNumber: row.job_number,
        status: row.status,
        buildQty: row.build_qty,
        startDate: row.start_date,
        endDate: row.end_date,
        assignedTeam: row.assigned_team,
        notes: row.notes,
        createdAt: row.created_at
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/build-jobs/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      const { rowCount } = await query('DELETE FROM build_jobs WHERE id = $1', [id]);
      if (rowCount === 0) return res.status(404).json({ error: 'build job not found' });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- PHASE 3: PRODUCTION / ORDER MANAGEMENT ---------------------------

  // Production Jobs (enhanced)
  app.get('/api/production-jobs', async (req, res) => {
    const status = req.query.status as string | undefined;
    try {
      let sql = 'SELECT * FROM production_jobs';
      const params: any[] = [];
      if (status) {
        sql += ' WHERE status = $1';
        params.push(status);
      }
      sql += ' ORDER BY scheduled_start DESC';
      const { rows } = await query(sql, params);
      res.json(rows.map((row: any) => ({
        id: row.id,
        jobNumber: row.job_number,
        clientOrderId: row.client_order_id,
        projectId: row.project_id,
        status: row.status,
        priority: row.priority,
        buildQty: row.build_qty,
        completedQty: row.completed_qty,
        defectQty: row.defect_qty,
        yieldPct: row.yield_pct,
        scheduledStart: row.scheduled_start,
        scheduledEnd: row.scheduled_end,
        actualStart: row.actual_start,
        actualEnd: row.actual_end,
        assignedTeam: row.assigned_team,
        notes: row.notes,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/production-jobs', async (req, res) => {
    const { jobNumber, clientOrderId, projectId, status, priority, buildQty, scheduledStart, scheduledEnd, assignedTeam, notes } = req.body;
    if (!jobNumber) return res.status(400).json({ error: 'jobNumber is required' });

    try {
      const row = await queryOne(
        `INSERT INTO production_jobs (job_number, client_order_id, project_id, status, priority, build_qty, scheduled_start, scheduled_end, assigned_team, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [jobNumber, clientOrderId || null, projectId || null, status || 'PLANNED', priority || 'MEDIUM', buildQty || 1, scheduledStart || null, scheduledEnd || null, assignedTeam || null, notes || null]
      );
      res.status(201).json({
        id: row?.id,
        jobNumber: row?.job_number,
        clientOrderId: row?.client_order_id,
        projectId: row?.project_id,
        status: row?.status,
        priority: row?.priority,
        buildQty: row?.build_qty,
        completedQty: row?.completed_qty,
        defectQty: row?.defect_qty,
        yieldPct: row?.yield_pct,
        scheduledStart: row?.scheduled_start,
        scheduledEnd: row?.scheduled_end,
        assignedTeam: row?.assigned_team,
        notes: row?.notes,
        createdAt: row?.created_at,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/production-jobs/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const { status, completedQty, defectQty, actualStart, actualEnd, notes } = req.body;
    try {
      const row = await queryOne(
        `UPDATE production_jobs SET status = COALESCE($1, status), completed_qty = COALESCE($2, completed_qty),
         defect_qty = COALESCE($3, defect_qty), actual_start = COALESCE($4, actual_start),
         actual_end = COALESCE($5, actual_end), notes = COALESCE($6, notes), updated_at = now()
         WHERE id = $7 RETURNING *`,
        [status || null, completedQty ?? null, defectQty ?? null, actualStart || null, actualEnd || null, notes || null, id]
      );
      if (!row) return res.status(404).json({ error: 'Production job not found' });
      res.json({
        id: row.id,
        jobNumber: row.job_number,
        status: row.status,
        completedQty: row.completed_qty,
        defectQty: row.defect_qty,
        actualStart: row.actual_start,
        actualEnd: row.actual_end,
        updatedAt: row.updated_at,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Work Orders
  app.get('/api/work-orders', async (req, res) => {
    const jobId = req.query.jobId as string | undefined;
    try {
      let sql = 'SELECT * FROM work_orders';
      const params: any[] = [];
      if (jobId) {
        sql += ' WHERE production_job_id = $1';
        params.push(parseInt(jobId));
      }
      sql += ' ORDER BY sequence_order ASC';
      const { rows } = await query(sql, params);
      res.json(rows.map((row: any) => ({
        id: row.id,
        productionJobId: row.production_job_id,
        workOrderNumber: row.work_order_number,
        workType: row.work_type,
        description: row.description,
        status: row.status,
        sequenceOrder: row.sequence_order,
        assignedTo: row.assigned_to,
        estimatedHours: row.estimated_hours,
        actualHours: row.actual_hours,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        createdAt: row.created_at,
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/work-orders', async (req, res) => {
    const { productionJobId, workOrderNumber, workType, description, status, sequenceOrder, assignedTo, estimatedHours } = req.body;
    if (!productionJobId || !workOrderNumber || !workType) {
      return res.status(400).json({ error: 'productionJobId, workOrderNumber, and workType are required' });
    }

    try {
      const row = await queryOne(
        `INSERT INTO work_orders (production_job_id, work_order_number, work_type, description, status, sequence_order, assigned_to, estimated_hours)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [productionJobId, workOrderNumber, workType, description || null, status || 'PENDING', sequenceOrder || 1, assignedTo || null, estimatedHours || null]
      );
      res.status(201).json({
        id: row?.id,
        productionJobId: row?.production_job_id,
        workOrderNumber: row?.work_order_number,
        workType: row?.work_type,
        status: row?.status,
        sequenceOrder: row?.sequence_order,
        createdAt: row?.created_at,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/work-orders/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const { status, actualHours, startedAt, completedAt } = req.body;
    try {
      const row = await queryOne(
        `UPDATE work_orders SET status = COALESCE($1, status), actual_hours = COALESCE($2, actual_hours),
         started_at = COALESCE($3, started_at), completed_at = COALESCE($4, completed_at)
         WHERE id = $5 RETURNING *`,
        [status || null, actualHours ?? null, startedAt || null, completedAt || null, id]
      );
      if (!row) return res.status(404).json({ error: 'Work order not found' });
      res.json({
        id: row.id,
        status: row.status,
        actualHours: row.actual_hours,
        startedAt: row.started_at,
        completedAt: row.completed_at,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Component Allocation to Jobs
  app.get('/api/job-allocations/:jobId', async (req, res) => {
    const jobId = parseInt(req.params.jobId);
    try {
      const { rows } = await query(
        'SELECT * FROM job_component_allocation WHERE production_job_id = $1 ORDER BY allocated_at DESC',
        [jobId]
      );
      res.json(rows.map((row: any) => ({
        id: row.id,
        productionJobId: row.production_job_id,
        componentId: row.component_id,
        qtyAllocated: row.qty_allocated,
        qtyConsumed: row.qty_consumed,
        qtyDefective: row.qty_defective,
        allocatedAt: row.allocated_at,
        consumedAt: row.consumed_at,
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/job-allocations', async (req, res) => {
    const { productionJobId, componentId, qtyAllocated } = req.body;
    if (!productionJobId || !componentId || !qtyAllocated) {
      return res.status(400).json({ error: 'productionJobId, componentId, and qtyAllocated are required' });
    }

    try {
      const row = await queryOne(
        `INSERT INTO job_component_allocation (production_job_id, component_id, qty_allocated)
         VALUES ($1, $2, $3) RETURNING *`,
        [productionJobId, componentId, qtyAllocated]
      );
      res.status(201).json({
        id: row?.id,
        productionJobId: row?.production_job_id,
        componentId: row?.component_id,
        qtyAllocated: row?.qty_allocated,
        qtyConsumed: row?.qty_consumed,
        qtyDefective: row?.qty_defective,
        allocatedAt: row?.allocated_at,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/job-allocations/:id/consume', async (req, res) => {
    const id = parseInt(req.params.id);
    const { qtyConsumed, qtyDefective } = req.body;
    try {
      const row = await queryOne(
        `UPDATE job_component_allocation SET qty_consumed = COALESCE($1, qty_consumed),
         qty_defective = COALESCE($2, qty_defective), consumed_at = now()
         WHERE id = $3 RETURNING *`,
        [qtyConsumed ?? null, qtyDefective ?? null, id]
      );
      if (!row) return res.status(404).json({ error: 'Allocation not found' });
      res.json({
        id: row.id,
        qtyConsumed: row.qty_consumed,
        qtyDefective: row.qty_defective,
        consumedAt: row.consumed_at,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Quality Control Checkpoints
  app.get('/api/qc-checkpoints/:jobId', async (req, res) => {
    const jobId = parseInt(req.params.jobId);
    try {
      const { rows } = await query(
        'SELECT * FROM qc_checkpoints WHERE production_job_id = $1 ORDER BY sequence_order ASC',
        [jobId]
      );
      res.json(rows.map((row: any) => ({
        id: row.id,
        productionJobId: row.production_job_id,
        checkpointName: row.checkpoint_name,
        checkpointType: row.checkpoint_type,
        sequenceOrder: row.sequence_order,
        status: row.status,
        inspector: row.inspector,
        inspectedAt: row.inspected_at,
        result: row.result,
        defectsFound: row.defects_found,
        notes: row.notes,
        createdAt: row.created_at,
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/qc-checkpoints', async (req, res) => {
    const { productionJobId, checkpointName, checkpointType, sequenceOrder } = req.body;
    if (!productionJobId || !checkpointName || !checkpointType) {
      return res.status(400).json({ error: 'productionJobId, checkpointName, and checkpointType are required' });
    }

    try {
      const row = await queryOne(
        `INSERT INTO qc_checkpoints (production_job_id, checkpoint_name, checkpoint_type, sequence_order)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [productionJobId, checkpointName, checkpointType, sequenceOrder || 1]
      );
      res.status(201).json({
        id: row?.id,
        productionJobId: row?.production_job_id,
        checkpointName: row?.checkpoint_name,
        checkpointType: row?.checkpoint_type,
        status: row?.status,
        createdAt: row?.created_at,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/qc-checkpoints/:id/complete', async (req, res) => {
    const id = parseInt(req.params.id);
    const { inspector, result, defectsFound, notes } = req.body;
    try {
      const row = await queryOne(
        `UPDATE qc_checkpoints SET status = 'COMPLETED', inspector = $1, result = $2,
         defects_found = $3, notes = $4, inspected_at = now()
         WHERE id = $5 RETURNING *`,
        [inspector || null, result || 'PASS', defectsFound || 0, notes || null, id]
      );
      if (!row) return res.status(404).json({ error: 'QC checkpoint not found' });
      res.json({
        id: row.id,
        status: row.status,
        result: row.result,
        defectsFound: row.defects_found,
        inspectedAt: row.inspected_at,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Production Defects
  app.get('/api/production-defects/:jobId', async (req, res) => {
    const jobId = parseInt(req.params.jobId);
    try {
      const { rows } = await query(
        'SELECT * FROM production_defects WHERE production_job_id = $1 ORDER BY discovered_at DESC',
        [jobId]
      );
      res.json(rows.map((row: any) => ({
        id: row.id,
        productionJobId: row.production_job_id,
        qcCheckpointId: row.qc_checkpoint_id,
        defectCode: row.defect_code,
        defectDescription: row.defect_description,
        severity: row.severity,
        componentAffected: row.component_affected,
        rootCause: row.root_cause,
        correctiveAction: row.corrective_action,
        status: row.status,
        discoveredAt: row.discovered_at,
        resolvedAt: row.resolved_at,
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/production-defects', async (req, res) => {
    const { productionJobId, qcCheckpointId, defectCode, defectDescription, severity, componentAffected } = req.body;
    if (!productionJobId || !defectCode) {
      return res.status(400).json({ error: 'productionJobId and defectCode are required' });
    }

    try {
      const row = await queryOne(
        `INSERT INTO production_defects (production_job_id, qc_checkpoint_id, defect_code, defect_description, severity, component_affected)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [productionJobId, qcCheckpointId || null, defectCode, defectDescription || null, severity || 'MEDIUM', componentAffected || null]
      );
      res.status(201).json({
        id: row?.id,
        productionJobId: row?.production_job_id,
        defectCode: row?.defect_code,
        status: row?.status,
        discoveredAt: row?.discovered_at,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/production-defects/:id/resolve', async (req, res) => {
    const id = parseInt(req.params.id);
    const { rootCause, correctiveAction } = req.body;
    try {
      const row = await queryOne(
        `UPDATE production_defects SET status = 'RESOLVED', root_cause = $1, corrective_action = $2, resolved_at = now()
         WHERE id = $3 RETURNING *`,
        [rootCause || null, correctiveAction || null, id]
      );
      if (!row) return res.status(404).json({ error: 'Defect not found' });
      res.json({
        id: row.id,
        status: row.status,
        rootCause: row.root_cause,
        correctiveAction: row.corrective_action,
        resolvedAt: row.resolved_at,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Order Fulfillment
  app.get('/api/order-fulfillment', async (req, res) => {
    const orderId = req.query.orderId as string | undefined;
    try {
      let sql = 'SELECT * FROM order_fulfillment';
      const params: any[] = [];
      if (orderId) {
        sql += ' WHERE client_order_id = $1';
        params.push(parseInt(orderId));
      }
      sql += ' ORDER BY created_at DESC';
      const { rows } = await query(sql, params);
      res.json(rows.map((row: any) => ({
        id: row.id,
        clientOrderId: row.client_order_id,
        productionJobId: row.production_job_id,
        fulfillmentStatus: row.fulfillment_status,
        qtyOrdered: row.qty_ordered,
        qtyBuilt: row.qty_built,
        qtyShipped: row.qty_shipped,
        expectedShipDate: row.expected_ship_date,
        actualShipDate: row.actual_ship_date,
        trackingNumber: row.tracking_number,
        notes: row.notes,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/order-fulfillment', async (req, res) => {
    const { clientOrderId, productionJobId, qtyOrdered, expectedShipDate, notes } = req.body;
    if (!clientOrderId || !qtyOrdered) {
      return res.status(400).json({ error: 'clientOrderId and qtyOrdered are required' });
    }

    try {
      const row = await queryOne(
        `INSERT INTO order_fulfillment (client_order_id, production_job_id, qty_ordered, expected_ship_date, notes)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [clientOrderId, productionJobId || null, qtyOrdered, expectedShipDate || null, notes || null]
      );
      res.status(201).json({
        id: row?.id,
        clientOrderId: row?.client_order_id,
        fulfillmentStatus: row?.fulfillment_status,
        qtyOrdered: row?.qty_ordered,
        createdAt: row?.created_at,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/order-fulfillment/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const { fulfillmentStatus, qtyBuilt, qtyShipped, actualShipDate, trackingNumber, notes } = req.body;
    try {
      const row = await queryOne(
        `UPDATE order_fulfillment SET fulfillment_status = COALESCE($1, fulfillment_status),
         qty_built = COALESCE($2, qty_built), qty_shipped = COALESCE($3, qty_shipped),
         actual_ship_date = COALESCE($4, actual_ship_date), tracking_number = COALESCE($5, tracking_number),
         notes = COALESCE($6, notes), updated_at = now()
         WHERE id = $7 RETURNING *`,
        [fulfillmentStatus || null, qtyBuilt ?? null, qtyShipped ?? null, actualShipDate || null, trackingNumber || null, notes || null, id]
      );
      if (!row) return res.status(404).json({ error: 'Order fulfillment not found' });
      res.json({
        id: row.id,
        fulfillmentStatus: row.fulfillment_status,
        qtyBuilt: row.qty_built,
        qtyShipped: row.qty_shipped,
        actualShipDate: row.actual_ship_date,
        trackingNumber: row.tracking_number,
        updatedAt: row.updated_at,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Production Metrics/Analytics
  app.get('/api/production-metrics', async (req, res) => {
    const metricDate = req.query.date as string | undefined;
    try {
      let sql = 'SELECT * FROM production_metrics';
      const params: any[] = [];
      if (metricDate) {
        sql += ' WHERE metric_date = $1';
        params.push(metricDate);
      } else {
        sql += ' WHERE metric_date >= CURRENT_DATE - INTERVAL \'30 days\'';
      }
      sql += ' ORDER BY metric_date DESC';
      const { rows } = await query(sql, params);
      res.json(rows.map((row: any) => ({
        id: row.id,
        metricDate: row.metric_date,
        totalJobsStarted: row.total_jobs_started,
        totalJobsCompleted: row.total_jobs_completed,
        avgCycleTimeHours: row.avg_cycle_time_hours,
        avgYieldPct: row.avg_yield_pct,
        totalDefects: row.total_defects,
        defectRatePct: row.defect_rate_pct,
        onTimeCompletionPct: row.on_time_completion_pct,
        createdAt: row.created_at,
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/production-metrics/calculate', async (_req, res) => {
    try {
      const today = new Date().toISOString().split('T')[0];

      // Calculate metrics for today
      const jobsStarted = await queryOne<{ count: number }>(
        `SELECT COUNT(*) as count FROM production_jobs WHERE actual_start::date = $1`,
        [today]
      );
      const jobsCompleted = await queryOne<{ count: number }>(
        `SELECT COUNT(*) as count FROM production_jobs WHERE actual_end::date = $1 AND status = 'COMPLETED'`,
        [today]
      );
      const avgCycleTime = await queryOne<{ avg_hours: number | null }>(
        `SELECT EXTRACT(EPOCH FROM (actual_end - actual_start))/3600 as avg_hours
         FROM production_jobs WHERE actual_end::date = $1 AND status = 'COMPLETED'`,
        [today]
      );
      const avgYield = await queryOne<{ avg_yield: number | null }>(
        `SELECT AVG(yield_pct) as avg_yield FROM production_jobs WHERE actual_end::date = $1`,
        [today]
      );
      const totalDefects = await queryOne<{ count: number }>(
        `SELECT COUNT(*) as count FROM production_defects WHERE discovered_at::date = $1`,
        [today]
      );

      // Upsert metrics
      const row = await queryOne(
        `INSERT INTO production_metrics (metric_date, total_jobs_started, total_jobs_completed, avg_cycle_time_hours, avg_yield_pct, total_defects)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (metric_date) DO UPDATE SET
           total_jobs_started = $2, total_jobs_completed = $3, avg_cycle_time_hours = $4, avg_yield_pct = $5, total_defects = $6
         RETURNING *`,
        [today, jobsStarted?.count || 0, jobsCompleted?.count || 0, avgCycleTime?.avg_hours || 0, avgYield?.avg_yield || 0, totalDefects?.count || 0]
      );
      res.json({
        metricDate: row?.metric_date,
        totalJobsStarted: row?.total_jobs_started,
        totalJobsCompleted: row?.total_jobs_completed,
        avgCycleTimeHours: row?.avg_cycle_time_hours,
        avgYieldPct: row?.avg_yield_pct,
        totalDefects: row?.total_defects,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Kit booking (validate + execute) ---------------------------------
  // execute wraps the deduction in a single transaction: if any component
  // is short, we roll back rather than leaving inventory partly consumed.
  app.post('/api/kit-booking/validate', async (req, res) => {
    const { projectId, buildQty, excludeKitId } = req.body;
    if (!projectId || !buildQty) {
      return res.status(400).json({ error: 'projectId and buildQty are required' });
    }

    try {
      // excludeKitId lets the operator edit an already-saved kit
      // without its own reservations counting against it — otherwise
      // reloading a locked kit would show every part as double-reserved.
      const auditResults = await auditKitStock(Number(projectId), Number(buildQty), {
        excludeKitId: excludeKitId != null ? Number(excludeKitId) : null,
      });
      res.json(auditResults);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/kit-booking/execute', async (req, res) => {
    const { projectId, buildQty } = req.body;
    if (!projectId || !buildQty) {
      return res.status(400).json({ error: 'projectId and buildQty are required' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const auditResults = await auditKitStock(Number(projectId), Number(buildQty));
      const shortages = auditResults.filter(r => r.shortage_qty > 0);

      if (shortages.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Insufficient stock for ${shortages.length} items. Booking blocked.` });
      }

      const now = new Date().toISOString();

      for (const result of auditResults) {
        const partToDeduct = result.resolved_part_number;
        const qtyToDeduct = result.qty_required;
        await client.query('UPDATE inventory SET stock = stock - $1 WHERE serial_number = $2', [qtyToDeduct, partToDeduct]);

        const item = await queryOne(`SELECT name FROM inventory WHERE serial_number = $1`, [partToDeduct]);
        const trxId = `TRX-KIT-${partToDeduct}-${Date.now()}`;
        await client.query(`INSERT INTO transactions (trxId, itemPartNumber, itemName, type, qtyChange, reference, performedBy, dateTime)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [trxId, partToDeduct, item?.name || 'Unknown', 'BOOK-OUT', -qtyToDeduct, `Kit Booking: Project ${projectId}`, 'System', now]);
      }

      const project = await queryOne(`SELECT assigned_team FROM projects WHERE id = $1`, [projectId]);
      await client.query(`INSERT INTO job_cards (project_id, build_qty, status, created_at, assigned_team) VALUES ($1, $2, $3, $4, $5)`,
        [projectId, buildQty, 'In Progress', now, project?.assigned_team || '']);

      await client.query('COMMIT');
      res.json({ ok: true, auditResults });
    } catch (err: any) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  // --- Admin BOM editor ---------------------------------------------------
  // Admins-only surface for editing the raw BOM rows that feed every
  // manufacturing / kit-booking view. All those views read live from these
  // same db_bom_* tables at request time, so a successful save here shows
  // up everywhere on the next fetch — no cache to invalidate, no follow-up
  // writes to other tables. The heavy lifting is table-shape variance:
  // legacy tables (db_bom, db_bom_tcu06, db_bom_ncu04, db_bom_loradongle)
  // carry only 4 columns; the newer per-project tables have 8. We handle
  // that by (a) reporting each row with its source table so the client can
  // know what's editable, and (b) INSERTing new rows into the canonical
  // per-project table (creating it if missing).
  //
  // Row identity uses postgres's system `ctid` — stable within a
  // transaction, sufficient across a normal edit session, and it means we
  // don't have to invent a synthetic primary key on schemas we can't
  // touch. Clients round-trip {table, ctid} back to us on save.

  // Column set for the canonical per-project table. Any new row lands here.
  const CANONICAL_COLS = ['project_name', 'internal_stock_number', 'qty_per_unit', 'ref_des', 'description', 'comment', 'footprint', 'libref'] as const;

  // The same table set auditKitStock consults, in the same order — so the
  // edit view and the audit view stay in agreement on which rows exist.
  async function bomTablesForProject(projectId: number): Promise<string[]> {
    const { rows: tables } = await query<{ tablename: string }>(
      `SELECT c.relname as tablename FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'db_bom%'`
    );
    return tables
      .map(t => t.tablename)
      .filter(t =>
        t === 'db_bom' ||
        t === 'db_bom_ncu04' ||
        t === 'db_bom_loradongle' ||
        t === `db_bom_project_${projectId}`
      );
  }

  async function columnsOf(table: string): Promise<Set<string>> {
    const { rows } = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
      [table]
    );
    return new Set(rows.map(r => r.column_name));
  }

  async function ensureCanonicalTable(projectId: number): Promise<string> {
    const table = `db_bom_project_${projectId}`;
    // CREATE TABLE IF NOT EXISTS with the canonical column set. text
    // everywhere — matches every existing per-project table's schema.
    await exec(`CREATE TABLE IF NOT EXISTS "${table}" (
      project_name text,
      internal_stock_number text,
      qty_per_unit integer,
      ref_des text,
      description text,
      comment text,
      footprint text,
      libref text
    )`);
    return table;
  }

  app.get('/api/kit-booking/bom/:projectId', requireAdmin, async (req, res) => {
    const projectId = Number(req.params.projectId);
    if (!projectId || Number.isNaN(projectId)) return res.status(400).json({ error: 'invalid projectId' });
    try {
      const tables = await bomTablesForProject(projectId);
      const out: any[] = [];
      // Collect distinct stock codes as we walk the tables so we can do
      // one lookup into `inventory` for their canonical description /
      // comment / footprint (legacy BOM tables don't store any of those,
      // and the audit view falls back to inventory for the same reason —
      // the editor has to show the same fallback or a legacy row lands
      // in the modal with a blank description, which reads as "we lost
      // your data" even though nothing was ever there).
      const stockCodes = new Set<string>();
      const rawRows: Array<{ table: string; ctid: string; r: any; stockCode: string }> = [];
      for (const t of tables) {
        const { rows } = await query(`SELECT ctid::text as ctid, * FROM "${t}"`);
        for (const r of rows as any[]) {
          const rowProject = parseInt(String(r.project_name ?? '')) || 1;
          if (rowProject !== projectId) continue;
          const stockCode = String(r.internal_stock_number || r.stock_code || '');
          if (stockCode) stockCodes.add(stockCode);
          rawRows.push({ table: t, ctid: r.ctid, r, stockCode });
        }
      }
      const inventoryByCode = new Map<string, { description: string; comment: string; footprint: string }>();
      if (stockCodes.size > 0) {
        const { rows: invRows } = await query<{ serial_number: string; description: string | null; comment: string | null; footprint: string | null }>(
          `SELECT serial_number, description, comment, footprint FROM inventory WHERE serial_number = ANY($1::text[])`,
          [Array.from(stockCodes)]
        );
        for (const inv of invRows) {
          inventoryByCode.set(inv.serial_number, {
            description: String(inv.description || ''),
            comment: String(inv.comment || ''),
            footprint: String(inv.footprint || ''),
          });
        }
      }
      for (const { table, ctid, r, stockCode } of rawRows) {
        const inv = inventoryByCode.get(stockCode);
        out.push({
          id: `${table}::${ctid}`,
          _table: table,
          _ctid: ctid,
          stockCode,
          quantity: parseInt(r.qty_per_unit || r.quantity || '1') || 1,
          designator: String(r.ref_des || r.designator || ''),
          description: String(r.description || ''),
          comment: String(r.comment || ''),
          footprint: String(r.footprint || ''),
          libref: String(r.libref || ''),
          // Canonical values from the inventory table, so the client can
          // display them when the row's own field is blank (legacy tables
          // always are). Never used as an edit target — the row's own
          // column is what gets written back.
          inventoryDescription: inv?.description || '',
          inventoryComment: inv?.comment || '',
          inventoryFootprint: inv?.footprint || '',
        });
      }
      res.json(out);
    } catch (err: any) {
      console.error('[bom:list] failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Body shape: { updates: [{id, stockCode, quantity, designator, description, comment, footprint, libref}],
  //               deletes: [id],
  //               inserts: [{stockCode, quantity, designator, description, comment, footprint, libref}] }
  const BomEditBody = z.object({
    updates: z.array(z.object({
      id: z.string().min(1),
      stockCode: z.string().max(200).default(''),
      quantity: z.coerce.number().int().min(0).max(1_000_000).default(1),
      designator: z.string().max(1000).default(''),
      description: z.string().max(1000).default(''),
      comment: z.string().max(1000).default(''),
      footprint: z.string().max(200).default(''),
      libref: z.string().max(200).default(''),
    })).default([]),
    deletes: z.array(z.string().min(1)).default([]),
    inserts: z.array(z.object({
      stockCode: z.string().min(1).max(200),
      quantity: z.coerce.number().int().min(0).max(1_000_000).default(1),
      designator: z.string().max(1000).default(''),
      description: z.string().max(1000).default(''),
      comment: z.string().max(1000).default(''),
      footprint: z.string().max(200).default(''),
      libref: z.string().max(200).default(''),
    })).default([]),
  });

  app.post('/api/kit-booking/bom/:projectId', requireAdmin, async (req, res) => {
    const projectId = Number(req.params.projectId);
    if (!projectId || Number.isNaN(projectId)) return res.status(400).json({ error: 'invalid projectId' });

    const parsed = BomEditBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid body', details: parsed.error.flatten() });
    const { updates, deletes, inserts } = parsed.data;

    // Parse "table::ctid" once, so a malformed id fails before we start
    // mutating anything.
    const parseId = (id: string): { table: string; ctid: string } | null => {
      const idx = id.indexOf('::');
      if (idx < 0) return null;
      const table = id.slice(0, idx);
      const ctid = id.slice(idx + 2);
      if (!/^db_bom[a-z0-9_]*$/.test(table)) return null; // only db_bom* tables
      if (!/^\(\d+,\d+\)$/.test(ctid)) return null;       // "(0,3)" form
      return { table, ctid };
    };

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // DELETEs first — no dependency on other operations, and doing them
      // first keeps the update path from having to skip rows the user
      // deleted in the same save.
      for (const id of deletes) {
        const parsedId = parseId(id);
        if (!parsedId) throw new Error(`invalid row id: ${id}`);
        await client.query(`DELETE FROM "${parsedId.table}" WHERE ctid = $1::tid`, [parsedId.ctid]);
      }

      // UPDATEs — only touch columns that actually exist on the target
      // table. Legacy tables (db_bom, db_bom_tcu06, db_bom_ncu04,
      // db_bom_loradongle) carry only 4 cols; description/comment/
      // footprint/libref get silently dropped rather than erroring the
      // whole save.
      for (const u of updates) {
        const parsedId = parseId(u.id);
        if (!parsedId) throw new Error(`invalid row id: ${u.id}`);
        const cols = await columnsOf(parsedId.table);
        const sets: string[] = [];
        const vals: any[] = [];
        const push = (col: string, val: any) => {
          if (!cols.has(col)) return;
          sets.push(`"${col}" = $${sets.length + 1}`);
          vals.push(val);
        };
        push('internal_stock_number', u.stockCode);
        push('qty_per_unit', u.quantity);
        push('ref_des', u.designator);
        push('description', u.description);
        push('comment', u.comment);
        push('footprint', u.footprint);
        push('libref', u.libref);
        if (sets.length === 0) continue; // nothing to update
        vals.push(parsedId.ctid);
        await client.query(
          `UPDATE "${parsedId.table}" SET ${sets.join(', ')} WHERE ctid = $${sets.length + 1}::tid`,
          vals
        );
      }

      // INSERTs — always into the canonical per-project table so we don't
      // spread new rows across legacy shapes.
      if (inserts.length > 0) {
        const table = await ensureCanonicalTable(projectId);
        for (const i of inserts) {
          await client.query(
            `INSERT INTO "${table}" (${CANONICAL_COLS.map(c => `"${c}"`).join(',')}) VALUES (${CANONICAL_COLS.map((_, k) => `$${k + 1}`).join(',')})`,
            [String(projectId), i.stockCode, i.quantity, i.designator, i.description, i.comment, i.footprint, i.libref]
          );
        }
      }

      // Bump the project's updated_at so the "Last edited" chip in
      // ProjectsView + P&P Kit Booking reflects BOM edits, not just
      // direct edits to the projects row itself. Best-effort — a
      // silent failure here doesn't roll back the BOM change.
      await client.query(`UPDATE projects SET updated_at = now() WHERE id::int = $1`, [projectId]).catch(() => {});
      await client.query('COMMIT');
      console.log(`[bom:save] project=${projectId} updates=${updates.length} deletes=${deletes.length} inserts=${inserts.length} by=${(req as any).user?.email || 'unknown'}`);
      // Activity ledger: BOM edits are audit-worthy. Fire-and-forget
      // so a log failure never fails the outer BOM write.
      try {
        const email = (req as any).user?.email;
        if (email) {
          const xf = String(req.headers?.['x-forwarded-for'] || '');
          const ip = xf.split(',')[0].trim() || (req.socket?.remoteAddress || '').split(':').pop() || '';
          const ua = String(req.headers?.['user-agent'] || '');
          await query(
            `INSERT INTO user_activity_logs (user_email, action, entity_type, entity_id, details, ip_address, user_agent, status)
             VALUES ($1,'BOM_EDIT','Project',$2,$3,$4,$5,'SUCCESS')`,
            [email, String(projectId), JSON.stringify({ projectId, updates: updates.length, deletes: deletes.length, inserts: inserts.length }), ip, ua]
          );
        }
      } catch { /* audit gap is preferable to a hard 500 on the BOM write */ }
      res.json({ ok: true, applied: { updates: updates.length, deletes: deletes.length, inserts: inserts.length } });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[bom:save] failed:', err.message);
      res.status(400).json({ error: err.message });
    } finally {
      client.release();
    }
  });
}
