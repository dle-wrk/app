// Auto-PO routes (the rules: ./autoPo).
//   GET    /api/auto-po-config              every watched item, with its stock and whether it is due
//   POST   /api/auto-po-config              watch items: {componentIds, minStockLevel, autoPOThreshold, preferredSupplier?, autoApprove?}
//   PUT    /api/auto-po-config/:id          change one item's setting
//   DELETE /api/auto-po-config/:id          stop watching an item
//   GET    /api/auto-po-config/preview      what a check would draft now (changes nothing)
//   POST   /api/automation/run-auto-po      draft it
//   POST   /api/automation/trigger-auto-po  {componentId}: the same, for one item
// Writes need automation.create / automation.delete (./writeAccess, area "automation").

import type { Express } from 'express';
import { pool, query } from './db';
import { nextDocNumber } from './bookkeeping-db';
import { planAutoPos, type AutoPoConfigRow } from './autoPo';
import { loadMeasuredLeadTimes } from './suppliersRoutes';
import type { MeasuredLeadTime } from './supplierLeadTime';

const mapConfig = (r: any) => ({
  id: r.id, componentId: r.component_id, name: r.name ?? null, stock: r.stock == null ? null : Number(r.stock),
  minStockLevel: r.min_stock_level, autoPOThreshold: r.auto_po_threshold, preferredSupplier: r.preferred_supplier || null,
  autoApprove: !!r.auto_approve, enabled: r.enabled !== false, due: r.stock != null && Number(r.stock) <= Number(r.auto_po_threshold),
  updatedAt: r.updated_at ?? r.created_at,
});

function parseLevels(body: any): { min: number; threshold: number } | string {
  const min = Number(body?.minStockLevel); const threshold = Number(body?.autoPOThreshold);
  if (!Number.isInteger(min) || min < 1) return 'The minimum level must be a whole number of 1 or more.';
  if (!Number.isInteger(threshold) || threshold < 0) return 'The reorder point must be a whole number of 0 or more.';
  if (threshold >= min) return 'The reorder point must be below the minimum level (it orders back up to the minimum).';
  return { min, threshold };
}

/** Everything a check needs, read in one go. */
async function loadPlanInputs(db: { query: (s: string, p?: any[]) => Promise<any> }, only?: string) {
  const cfg = await db.query(`SELECT * FROM auto_po_config WHERE enabled IS NOT FALSE${only ? ' AND component_id = $1' : ''} ORDER BY component_id`, only ? [only] : []);
  const parts = cfg.rows.map((c: any) => c.component_id);
  const items = await db.query(
    `SELECT serial_number, name, stock, current_cost_dollar, supplier, sup_pn_1, sup_pn_2, sup_pn_3 FROM inventory WHERE serial_number = ANY($1::text[]) AND deleted IS NOT TRUE`, [parts]);
  // Parts with a purchase order still open for them: not drafted again.
  const open = await db.query(
    `SELECT DISTINCT poi.part_number FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.purchase_order_id
      WHERE po.status IN ('DRAFT','SENT','PARTIAL') AND poi.part_number = ANY($1::text[]) AND COALESCE(poi.qty_received, 0) < poi.quantity`, [parts]);
  const suppliers = await db.query(`SELECT id, name, lead_time FROM suppliers`);
  const measured = await loadMeasuredLeadTimes().catch(() => new Map<string, MeasuredLeadTime>());
  return planAutoPos(cfg.rows as AutoPoConfigRow[], items.rows, new Set(open.rows.map((r: any) => r.part_number)), suppliers.rows, measured);
}

async function runAutoPo(who: string, dryRun: boolean, only?: string) {
  if (dryRun) return { ...(await loadPlanInputs({ query: (s, p) => query(s, p) }, only)), created: [] as any[] };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // One check at a time, so two presses can't draft the same order twice.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('auto-po'))`);
    const plan = await loadPlanInputs(client, only);
    const created: Array<{ id: number; poNumber: string; supplier: string | null; status: string; lines: number }> = [];
    for (const g of plan.groups) {
      const poNumber = await nextDocNumber(client as any, 'PO', 'po_seq');
      const subtotal = Math.round(g.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0) * 100) / 100;
      const notes = `Drafted by Auto-PO (checked by ${who}): ${g.lines.map((l) => `${l.partNumber} at ${l.stock}, reorder point ${l.threshold}`).join('; ')}. Prices are the items' last cost; check them before sending.`;
      const po = await client.query(
        `INSERT INTO purchase_orders (po_number, supplier_id, order_date, status, currency, subtotal, tax_total, total, notes)
         VALUES ($1, $2, CURRENT_DATE, $3, 'USD', $4, 0, $4, $5) RETURNING id`,
        [poNumber, g.supplierId, g.status, subtotal, notes]
      );
      const poId = po.rows[0].id;
      for (const l of g.lines) {
        await client.query(
          `INSERT INTO purchase_order_items (purchase_order_id, part_number, description, quantity, unit_price, tax_amount, line_total)
           VALUES ($1, $2, $3, $4, $5, 0, $6)`,
          [poId, l.partNumber, l.name || l.partNumber, l.quantity, l.unitPrice, Math.round(l.quantity * l.unitPrice * 100) / 100]
        );
      }
      await client.query(
        `INSERT INTO event_log (event_type, entity_type, entity_id, action, status, details) VALUES ('AUTO_PO_CREATED', 'PURCHASE_ORDER', $1, 'AUTO_TRIGGER', 'SUCCESS', $2)`,
        [String(poId), JSON.stringify({ poNumber, supplierId: g.supplierId, lines: g.lines.map((l) => ({ part: l.partNumber, qty: l.quantity, why: l.supplierReason })), by: who })]
      );
      created.push({ id: poId, poNumber, supplier: g.supplierName, status: g.status, lines: g.lines.length });
    }
    await client.query('COMMIT');
    return { ...plan, created };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export function registerAutoPoRoutes(app: Express): void {
  app.get('/api/auto-po-config', async (_req, res) => {
    try {
      const { rows } = await query(
        `SELECT c.*, i.name, i.stock FROM auto_po_config c LEFT JOIN inventory i ON i.serial_number = c.component_id AND i.deleted IS NOT TRUE ORDER BY c.component_id`);
      res.json(rows.map(mapConfig));
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/auto-po-config', async (req: any, res) => {
    const ids: string[] = [...new Set<string>((Array.isArray(req.body?.componentIds) ? req.body.componentIds : [req.body?.componentId]).filter((v: unknown) => typeof v === 'string' && v.trim()).map((v: string) => v.trim()))];
    if (!ids.length) return res.status(400).json({ error: 'Choose at least one item.' });
    const levels = parseLevels(req.body);
    if (typeof levels === 'string') return res.status(400).json({ error: levels });
    try {
      const known = await query(`SELECT serial_number FROM inventory WHERE serial_number = ANY($1::text[]) AND deleted IS NOT TRUE`, [ids]);
      const missing = ids.filter((id) => !known.rows.some((r: any) => r.serial_number === id));
      if (missing.length) return res.status(400).json({ error: `Not in inventory: ${missing.join(', ')}.` });
      // One setting per item: watching an item again replaces its setting.
      for (const id of ids) {
        await query(
          `INSERT INTO auto_po_config (component_id, min_stock_level, auto_po_threshold, preferred_supplier, auto_approve, enabled, updated_at)
           VALUES ($1, $2, $3, $4, $5, true, now())
           ON CONFLICT (component_id) DO UPDATE SET min_stock_level = EXCLUDED.min_stock_level, auto_po_threshold = EXCLUDED.auto_po_threshold,
             preferred_supplier = EXCLUDED.preferred_supplier, auto_approve = EXCLUDED.auto_approve, enabled = true, updated_at = now()`,
          [id, levels.min, levels.threshold, req.body.preferredSupplier || null, !!req.body.autoApprove]
        );
      }
      res.status(201).json({ saved: ids.length });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/auto-po-config/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const b = req.body ?? {};
    const sets: string[] = []; const params: any[] = [];
    const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    if (b.minStockLevel !== undefined || b.autoPOThreshold !== undefined) {
      const levels = parseLevels(b);
      if (typeof levels === 'string') return res.status(400).json({ error: levels });
      set('min_stock_level', levels.min); set('auto_po_threshold', levels.threshold);
    }
    if (b.preferredSupplier !== undefined) set('preferred_supplier', b.preferredSupplier || null); // '' clears it
    if (b.autoApprove !== undefined) set('auto_approve', !!b.autoApprove);
    if (b.enabled !== undefined) set('enabled', !!b.enabled);
    if (!sets.length) return res.status(400).json({ error: 'Nothing to change.' });
    try {
      params.push(id);
      const { rows } = await query(`UPDATE auto_po_config SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`, params);
      if (!rows.length) return res.status(404).json({ error: 'Auto-PO setting not found' });
      res.json(mapConfig(rows[0]));
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/auto-po-config/:id', async (req, res) => {
    try {
      const { rowCount } = await query(`DELETE FROM auto_po_config WHERE id = $1`, [parseInt(req.params.id)]);
      if (!rowCount) return res.status(404).json({ error: 'Auto-PO setting not found' });
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/auto-po-config/preview', async (req: any, res) => {
    try { res.json(await runAutoPo(req.user?.email || 'unknown', true)); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/automation/run-auto-po', async (req: any, res) => {
    try { res.json(await runAutoPo(req.user?.email || 'unknown', false)); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/automation/trigger-auto-po', async (req: any, res) => {
    const componentId = String(req.body?.componentId ?? '').trim();
    if (!componentId) return res.status(400).json({ error: 'componentId is required' });
    try { res.json(await runAutoPo(req.user?.email || 'unknown', req.body?.dryRun === true, componentId)); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });
}
