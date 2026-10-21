// Footprints for items that have none, read from what the item already says
// (its Size and Package fields, then its description and name): "CHIP LED
// 0402 RED SMD" is 0402, "MOSFET 100V 13A TO-252" is TO-252. Kit Booking and
// the BOM reel picker only treat two parts as equivalent (T2) when their
// footprints match (./kitMatch), so a blank footprint keeps a part out.
//
// Only a single, clear package is offered: none when the text names two, and
// never a size followed by METRIC ("0603 METRIC" is imperial 0201). The name
// is written as the footprints already in use spell it where one matches
// ("SOT23" -> "SOT-23").
//
//   GET  /api/inventory/footprint-fill         the items it would fill
//   POST /api/inventory/footprint-fill/apply   {items: [{serialNumber, footprint}]} (inventory.update)

import type { Express } from 'express';
import { pool, query } from './db';
import { requirePermission } from './authRoutes';
import { hasNoFootprint, proposeFootprint, type FootprintProposal } from './footprintRules';

const COLUMNS = 'serial_number, name, description, size, package, footprint';

async function proposals(): Promise<FootprintProposal[]> {
  const { rows } = await query<any>(`SELECT ${COLUMNS} FROM inventory WHERE deleted IS NOT TRUE ORDER BY serial_number`);
  const inUse = [...new Set(rows.map((r: any) => String(r.footprint ?? '').trim()).filter((f: string) => f && !hasNoFootprint(f)))] as string[];
  return rows.map((r: any) => proposeFootprint(r, inUse)).filter(Boolean) as FootprintProposal[];
}

export function registerFootprintFillRoutes(app: Express): void {
  app.get('/api/inventory/footprint-fill', async (_req, res) => {
    try { res.json({ proposals: await proposals() }); } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/inventory/footprint-fill/apply', requirePermission('inventory.update'), async (req: any, res) => {
    const list = Array.isArray(req.body?.items) ? req.body.items : null;
    if (!list?.length || list.length > 2000) return res.status(400).json({ error: 'items must be a list of 1 to 2000.' });
    const wanted = new Map<string, string>(list.filter((i: any) => typeof i?.serialNumber === 'string' && typeof i?.footprint === 'string').map((i: any) => [i.serialNumber, i.footprint]));
    const who = req.user?.email || 'unknown';
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`SELECT ${COLUMNS} FROM inventory WHERE serial_number = ANY($1::text[]) AND deleted IS NOT TRUE FOR UPDATE`, [[...wanted.keys()]]);
      const { rows: used } = await client.query(`SELECT DISTINCT TRIM(footprint) AS f FROM inventory WHERE deleted IS NOT TRUE AND footprint IS NOT NULL`);
      const inUse = used.map((u: any) => u.f).filter((f: string) => f && !hasNoFootprint(f));
      const applied: string[] = []; const skipped: Array<{ serialNumber: string; reason: string }> = [];
      for (const r of rows) {
        // Worked out again from what the item holds now; only that is written.
        const p = proposeFootprint(r, inUse);
        if (!p || p.footprint !== wanted.get(r.serial_number)) { skipped.push({ serialNumber: r.serial_number, reason: 'Changed since the list was made.' }); continue; }
        await client.query(`UPDATE inventory SET footprint = $1 WHERE serial_number = $2`, [p.footprint, r.serial_number]);
        await client.query(
          `INSERT INTO user_activity_logs (user_email, action, entity_type, entity_id, details, status) VALUES ((SELECT email FROM users WHERE email = $1), 'FILL_FOOTPRINT', 'Item', $2, $3, 'SUCCESS')`,
          [who, r.serial_number, JSON.stringify({ footprint: p.footprint, from: p.from, by: who })]
        );
        applied.push(r.serial_number);
      }
      await client.query('COMMIT');
      res.json({ applied, skipped });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  });
}
