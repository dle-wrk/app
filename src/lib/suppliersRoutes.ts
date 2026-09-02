// Supplier surface extracted from server.ts. Owns the CRUD list/create/update/
// delete for suppliers plus two read-only pricing-adjacent endpoints:
// /api/suppliers/price-history/:partNumber and /api/suppliers/performance.
//
// The seventh /api/suppliers/* route — POST /api/suppliers/compare-prices —
// stays in server.ts for now: it depends on the live pricing-provider helpers
// (isProviderConfigured, searchDigikey, searchMouser, getPricingUsage, ...)
// that still live inline. It will move here when pricing gets its own module.

import type { Express } from 'express';
import { query, queryOne } from './db';

export function registerSuppliersRoutes(app: Express): void {
  app.get('/api/suppliers', async (_req, res) => {
    const { rows } = await query('SELECT * FROM suppliers ORDER BY id');
    res.json(rows);
  });

  app.put('/api/suppliers/:id', async (req, res) => {
    const id = req.params.id;
    const { name, website, contact_email, notes, lead_time, response_time } = req.body;
    const sqlText = `UPDATE suppliers SET name = $1, website = $2, contact_email = $3, notes = $4, lead_time = $5, response_time = $6 WHERE id = $7`;
    try {
      const { rowCount } = await query(sqlText, [name, website, contact_email, notes, lead_time, response_time, id]);
      if (rowCount === 0) return res.status(404).json({ error: 'supplier not found' });
      const row = await queryOne(`SELECT * FROM suppliers WHERE id = $1`, [id]);
      res.json(row);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/suppliers', async (req, res) => {
    const { id, name, website, contact_email, notes, lead_time, response_time } = req.body;
    if (!id) return res.status(400).json({ error: 'id is required' });
    const sqlText = `INSERT INTO suppliers (id, name, website, contact_email, notes, lead_time, response_time) VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name, website=EXCLUDED.website, contact_email=EXCLUDED.contact_email, notes=EXCLUDED.notes, lead_time=EXCLUDED.lead_time, response_time=EXCLUDED.response_time`;
    try {
      await query(sqlText, [id, name, website, contact_email, notes, lead_time, response_time]);
      const row = await queryOne(`SELECT * FROM suppliers WHERE id = $1`, [id]);
      res.status(201).json(row);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Hard delete a supplier, but block the operation if anything still points
  // at it — a silent CASCADE would let the bills/POs it references vanish or
  // dangle. The client gets a specific error listing the counts so the user
  // knows what to reassign or void first.
  app.delete('/api/suppliers/:id', async (req, res) => {
    const id = String(req.params.id);
    try {
      const supplier = await queryOne<any>(`SELECT id FROM suppliers WHERE id = $1`, [id]);
      if (!supplier) return res.status(404).json({ error: 'supplier not found' });

      const [billCount, poCount, invCount] = await Promise.all([
        queryOne<{ n: string }>(`SELECT COUNT(*)::text AS n FROM bills WHERE supplier_id = $1`, [id]).then(r => Number(r?.n || 0)),
        queryOne<{ n: string }>(`SELECT COUNT(*)::text AS n FROM purchase_orders WHERE supplier_id = $1`, [id]).then(r => Number(r?.n || 0)),
        queryOne<{ n: string }>(`SELECT COUNT(*)::text AS n FROM inventory WHERE supplier = $1`, [id]).then(r => Number(r?.n || 0)),
      ]);
      const refs = [
        billCount && `${billCount} bill${billCount === 1 ? '' : 's'}`,
        poCount && `${poCount} purchase order${poCount === 1 ? '' : 's'}`,
        invCount && `${invCount} inventory item${invCount === 1 ? '' : 's'}`,
      ].filter(Boolean);
      if (refs.length) {
        return res.status(400).json({
          error: `Supplier is still referenced by ${refs.join(', ')}. Void or reassign those first.`,
          counts: { bills: billCount, purchaseOrders: poCount, inventoryItems: invCount },
        });
      }

      await query(`DELETE FROM suppliers WHERE id = $1`, [id]);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Read-only history of scraped/quoted prices for one part across suppliers.
  // Backing table is populated by /api/suppliers/compare-prices (still in
  // server.ts) and by the LCSC scrape ingestion.
  app.get('/api/suppliers/price-history/:partNumber', async (req, res) => {
    const { partNumber } = req.params;
    try {
      const history = await query(
        `SELECT supplier, price, stock, moq, lead_time_days, queried_at
         FROM supplier_price_history
         WHERE part_number = $1
         ORDER BY queried_at DESC
         LIMIT 100`,
        [partNumber]
      );
      res.json({ partNumber, history: history.rows });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Aggregate performance metrics per supplier (lookups, avg price/lead-time,
  // stock availability). Populated by a scheduled roll-up, not by writes here.
  app.get('/api/suppliers/performance', async (_req, res) => {
    try {
      const performance = await query(
        `SELECT supplier, total_lookups, avg_price, avg_lead_time_days, stock_availability_pct, last_updated
         FROM supplier_performance
         ORDER BY total_lookups DESC`,
        []
      );
      res.json({ suppliers: performance.rows });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
