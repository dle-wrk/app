// Material planning (the rules: ./materialPlan).
//   GET  /api/material-planning?quotes=1&kits=1&safety=1   the plan, per part
//   GET  /api/material-planning/products                    what each product is made of (boards per unit)
//   PUT  /api/material-planning/products/:model             {boards: [{projectId, perUnit}]}
//   POST /api/material-planning/draft-pos                   {lines: [{partNumber, qty}]}: DRAFT purchase orders, one per supplier
//
// A product sold on a sales order (TCU-001-SAT) is broken down through the
// boards it is made of (product_boards: TCU06 PCB × 1 …), each board through
// its project's BOM, read as Kit Booking's audit reads it. Sales orders count
// what isn't invoiced yet; quotes and saved kits count only when asked for.

import type { Express } from 'express';
import { pool, query, exec } from './db';
import { requirePermission } from './authRoutes';
import { nextDocNumber } from './bookkeeping-db';
import { explode, planParts, type Demand, type PartInfo, type Receipt } from './materialPlan';
import { loadMeasuredLeadTimes } from './suppliersRoutes';
import { leadTimeForSupplierName, slowestSlotLeadTime, findSupplier, type MeasuredLeadTime } from './supplierLeadTime';
import { pickSupplier } from './autoPo';

export async function ensureMaterialPlanningSchema(run: (sql: string) => Promise<void> = exec): Promise<void> {
  await run(`CREATE TABLE IF NOT EXISTS product_boards (
    id SERIAL PRIMARY KEY,
    model_number TEXT NOT NULL,
    project_id INTEGER NOT NULL,
    per_unit NUMERIC(10,3) NOT NULL DEFAULT 1 CHECK (per_unit > 0),
    UNIQUE (model_number, project_id)
  )`);
}

type Db = { query: (s: string, p?: any[]) => Promise<any> };
const httpError = (res: any, err: any) => res.status(err.status || 500).json({ error: err.message });

/** A project's BOM lines (stock code, quantity per board), read as Kit Booking's audit reads them. */
export async function projectBomLines(projectId: number): Promise<Array<{ code: string; qtyPerBoard: number }>> {
  const { rows: tables } = await query<{ tablename: string }>(`SELECT c.relname AS tablename FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'db_bom%'`);
  const wanted = tables.map((t) => t.tablename).filter((t) => ['db_bom', 'db_bom_ncu04', 'db_bom_loradongle', `db_bom_project_${projectId}`].includes(t));
  const out = new Map<string, number>();
  for (const t of wanted) {
    const { rows } = await query(`SELECT * FROM "${t}"`);
    for (const r of rows) {
      if ((parseInt(r.project_name || r.projectId || r.ProjectId) || 1) !== projectId) continue;
      const code = String(r.internal_stock_number || r.stock_code || r.StockCode || '').trim();
      if (!code) continue;
      out.set(code, (out.get(code) ?? 0) + (parseInt(r.qty_per_unit || r.quantity || r.Quantity) || 1));
    }
  }
  return [...out].map(([code, qtyPerBoard]) => ({ code, qtyPerBoard }));
}

async function buildPlan(opts: { quotes: boolean; kits: boolean; safety: boolean }) {
  const demands: Demand[] = []; const unmapped = new Map<string, number>();
  const { rows: boards } = await query(`SELECT pb.model_number, pb.project_id, pb.per_unit, p.project_name FROM product_boards pb LEFT JOIN projects p ON p.id::text = pb.project_id::text`);
  const bomCache = new Map<number, Array<{ code: string; qtyPerBoard: number }>>();
  const bom = async (pid: number) => { if (!bomCache.has(pid)) bomCache.set(pid, await projectBomLines(pid)); return bomCache.get(pid)!; };
  const { rows: items } = await query(`SELECT serial_number FROM inventory WHERE deleted IS NOT TRUE`);
  const isItem = new Set(items.map((i: any) => i.serial_number));

  // Sales orders (and quotes when asked): what isn't invoiced yet.
  const statuses = opts.quotes ? `('FULFILLED','CANCELLED','POTENTIAL')` : `('FULFILLED','CANCELLED','POTENTIAL','QUOTATION')`;
  const { rows: lines } = await query(
    `SELECT o.id, o.order_number, o.status, COALESCE(o.required_date, o.order_date) AS need, ci.part_number, ci.quantity::numeric AS qty,
            COALESCE((SELECT SUM(ii.quantity) FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
                       WHERE i.client_order_id = o.id AND i.status NOT IN ('VOID','DRAFT') AND ii.part_number = ci.part_number), 0)::numeric AS invoiced
       FROM client_order_items ci JOIN client_orders o ON o.id = ci.client_order_id
      WHERE o.status NOT IN ${statuses} AND ci.part_number IS NOT NULL`);
  for (const l of lines) {
    const left = Number(l.qty) - Number(l.invoiced);
    if (!(left > 0)) continue;
    const need = l.need ? new Date(l.need).toISOString() : null;
    const source = `${l.order_number}${l.status === 'QUOTATION' ? ' (quote)' : ''}`;
    const made = boards.filter((b: any) => b.model_number === l.part_number);
    if (made.length) {
      const parts = explode(left, await Promise.all(made.map(async (b: any) => ({ perUnit: Number(b.per_unit), lines: await bom(Number(b.project_id)) }))));
      for (const p of parts) demands.push({ partNumber: p.code, qty: p.qty, needBy: need, source: `${source}: ${left} × ${l.part_number}` });
    } else if (isItem.has(l.part_number)) {
      demands.push({ partNumber: l.part_number, qty: left, needBy: need, source });
    } else {
      unmapped.set(l.part_number, (unmapped.get(l.part_number) ?? 0) + left);
    }
  }

  // Planned production jobs: what is left to build.
  const { rows: jobs } = await query(
    `SELECT j.job_number, j.project_id, (COALESCE(j.build_qty, 0) - COALESCE(j.completed_qty, 0)) AS left, j.scheduled_start FROM production_jobs j
      WHERE COALESCE(j.status, '') NOT IN ('COMPLETED','CANCELLED','DONE') AND j.project_id IS NOT NULL`).catch(() => ({ rows: [] as any[] }));
  for (const j of jobs) {
    if (!(Number(j.left) > 0)) continue;
    for (const p of explode(Number(j.left), [{ perUnit: 1, lines: await bom(Number(j.project_id)) }])) {
      demands.push({ partNumber: p.code, qty: p.qty, needBy: j.scheduled_start ? new Date(j.scheduled_start).toISOString() : null, source: `Job ${j.job_number}` });
    }
  }

  // Saved kits, when asked: each a build of its BOM at its build quantity.
  if (opts.kits) {
    const { rows: kits } = await query(`SELECT k.id, k.name, k.build_qty, b.stock_code, b.qty_per_pcb FROM kits k JOIN kit_bom b ON b.kit_id = k.id`);
    for (const k of kits) {
      const qty = Number(k.build_qty) * Number(k.qty_per_pcb);
      if (qty > 0) demands.push({ partNumber: k.stock_code, qty, needBy: null, source: `Kit ${k.name}` });
    }
  }

  // Supply: stock, and open purchase-order lines by when they're due.
  const codes = [...new Set(demands.map((d) => d.partNumber))];
  const { rows: inv } = await query(`SELECT serial_number, name, stock, low_stock_lvl, supplier, sup_pn_1, sup_pn_2, sup_pn_3 FROM inventory WHERE serial_number = ANY($1::text[])`, [codes]);
  const { rows: pos } = await query(
    `SELECT poi.part_number, (poi.quantity - COALESCE(poi.qty_received, 0))::numeric AS qty, po.po_number, COALESCE(po.expected_date, po.order_date) AS due
       FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.purchase_order_id
      WHERE po.status IN ('DRAFT','SENT','PARTIAL') AND poi.part_number = ANY($1::text[])`, [codes]);
  const receipts: Receipt[] = pos.filter((p: any) => Number(p.qty) > 0).map((p: any) => ({ partNumber: p.part_number, qty: Number(p.qty), due: p.due ? new Date(p.due).toISOString() : null, source: p.po_number }));
  const { rows: suppliers } = await query(`SELECT id, name, lead_time FROM suppliers`);
  const measured = await loadMeasuredLeadTimes().catch(() => new Map<string, MeasuredLeadTime>());
  const parts = new Map<string, PartInfo>();
  for (const r of inv) {
    const own = leadTimeForSupplierName(r.supplier, suppliers, measured);
    const l = own ?? slowestSlotLeadTime([r.sup_pn_1, r.sup_pn_2, r.sup_pn_3], suppliers, measured);
    const sup = pickSupplier({ component_id: r.serial_number, min_stock_level: 0, auto_po_threshold: 0 }, r, suppliers, measured);
    parts.set(r.serial_number, {
      name: r.name ?? '', stock: Number(r.stock) || 0, safety: opts.safety ? Math.max(0, parseInt(r.low_stock_lvl) || 0) : 0,
      leadDays: l ? l.days : null, leadNote: l ? `${l.supplier}, ${l.source}` : 'no lead time known', supplier: sup.name,
    });
  }
  return { rows: planParts(demands, receipts, parts), unmapped: [...unmapped].map(([model, qty]) => ({ model, qty })), demandCount: demands.length };
}

export function registerMaterialPlanningRoutes(app: Express): void {
  app.get('/api/material-planning', async (req, res) => {
    try { res.json(await buildPlan({ quotes: req.query.quotes === '1', kits: req.query.kits === '1', safety: req.query.safety === '1' })); }
    catch (err) { httpError(res, err); }
  });

  app.get('/api/material-planning/products', async (_req, res) => {
    try {
      const { rows: products } = await query(`SELECT model_number, description, category FROM production_products ORDER BY model_number`);
      const { rows: boards } = await query(`SELECT model_number, project_id, per_unit FROM product_boards ORDER BY model_number, project_id`);
      const { rows: projects } = await query(`SELECT id, project_name, status FROM projects ORDER BY project_name`);
      res.json({ products: products.map((p: any) => ({ ...p, boards: boards.filter((b: any) => b.model_number === p.model_number).map((b: any) => ({ projectId: b.project_id, perUnit: Number(b.per_unit) })) })), projects });
    } catch (err) { httpError(res, err); }
  });

  app.put('/api/material-planning/products/:model', requirePermission('inventory.update'), async (req, res) => {
    const model = req.params.model;
    const boards = Array.isArray(req.body?.boards) ? req.body.boards : null;
    if (!boards) return res.status(400).json({ error: 'boards must be a list.' });
    const clean = boards.map((b: any) => ({ projectId: parseInt(b.projectId), perUnit: Number(b.perUnit) })).filter((b: any) => b.projectId > 0);
    if (clean.some((b: any) => !(b.perUnit > 0))) return res.status(400).json({ error: 'Boards per unit must be more than 0.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM product_boards WHERE model_number = $1`, [model]);
      for (const b of clean) await client.query(`INSERT INTO product_boards (model_number, project_id, per_unit) VALUES ($1, $2, $3) ON CONFLICT (model_number, project_id) DO UPDATE SET per_unit = EXCLUDED.per_unit`, [model, b.projectId, b.perUnit]);
      await client.query('COMMIT');
      res.json({ model, boards: clean });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      httpError(res, err);
    } finally { client.release(); }
  });

  app.post('/api/material-planning/draft-pos', requirePermission('inventory.update'), async (req: any, res) => {
    const lines = (Array.isArray(req.body?.lines) ? req.body.lines : []).map((l: any) => ({ partNumber: String(l.partNumber ?? ''), qty: Math.ceil(Number(l.qty)) })).filter((l: any) => l.partNumber && l.qty > 0);
    if (!lines.length) return res.status(400).json({ error: 'Choose what to order.' });
    const who = req.user?.email || 'unknown';
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: inv } = await client.query(`SELECT serial_number, name, current_cost_dollar, supplier, sup_pn_1, sup_pn_2, sup_pn_3 FROM inventory WHERE serial_number = ANY($1::text[])`, [lines.map((l: any) => l.partNumber)]);
      const { rows: suppliers } = await client.query(`SELECT id, name, lead_time FROM suppliers`);
      const measured = await loadMeasuredLeadTimes().catch(() => new Map<string, MeasuredLeadTime>());
      const groups = new Map<string, Array<{ part: string; name: string; qty: number; price: number }>>();
      const supName = new Map<string, string | null>();
      for (const l of lines) {
        const r = inv.find((i: any) => i.serial_number === l.partNumber);
        if (!r) continue;
        const preferred = req.body?.supplierId ? findSupplier(String(req.body.supplierId), suppliers) : undefined;
        const s = preferred ? { id: String(preferred.id), name: preferred.name } : pickSupplier({ component_id: r.serial_number, min_stock_level: 0, auto_po_threshold: 0 }, r, suppliers, measured);
        const key = s.id ?? '';
        supName.set(key, s.name);
        groups.set(key, [...(groups.get(key) ?? []), { part: r.serial_number, name: r.name || r.serial_number, qty: l.qty, price: Number(r.current_cost_dollar) || 0 }]);
      }
      const created: Array<{ poNumber: string; supplier: string | null; lines: number }> = [];
      for (const [supplierId, ls] of groups) {
        const poNumber = await nextDocNumber(client as any, 'PO', 'po_seq');
        const subtotal = Math.round(ls.reduce((s, l) => s + l.qty * l.price, 0) * 100) / 100;
        const { rows: [po] } = await client.query(
          `INSERT INTO purchase_orders (po_number, supplier_id, order_date, status, currency, subtotal, tax_total, total, notes) VALUES ($1, $2, CURRENT_DATE, 'DRAFT', 'USD', $3, 0, $3, $4) RETURNING id`,
          [poNumber, supplierId || null, subtotal, `From Material Planning (${who}). Prices are the items' last cost; check them before sending.`]);
        for (const l of ls) {
          await client.query(`INSERT INTO purchase_order_items (purchase_order_id, part_number, description, quantity, unit_price, tax_amount, line_total) VALUES ($1, $2, $3, $4, $5, 0, $6)`,
            [po.id, l.part, l.name, l.qty, l.price, Math.round(l.qty * l.price * 100) / 100]);
        }
        created.push({ poNumber, supplier: supName.get(supplierId) ?? null, lines: ls.length });
      }
      await client.query('COMMIT');
      res.status(201).json({ created });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      httpError(res, err);
    } finally { client.release(); }
  });
}
