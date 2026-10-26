// Web-link slots that aren't links (the rules: ./linkCleanup).
//   GET  /api/inventory/link-cleanup         what each such item would change to
//   POST /api/inventory/link-cleanup/apply   {items: [{serialNumber, from: {weblink_n: value}}]} (inventory.update)
//   GET  /api/inventory/data-checks          things in items' data that disagree, to check by hand (./dataChecks)
// A DigiKey page is asked of DigiKey by its part number (its real product
// page); when DigiKey can't be asked, a DigiKey search for the number is used.
// Applying works each item out again under a row lock and skips one whose
// links changed since the list was made.

import type { Express } from 'express';
import { pool, query } from './db';
import { requirePermission } from './authRoutes';
import { linkFixFor, type LinkFix } from './linkCleanup';
import { searchDigikey } from './pricingRoutes';
import { checkItems } from './dataChecks';

const COLUMNS = ['serial_number', 'supplier', ...[1, 2, 3, 4, 5].flatMap((n) => [`sup_pn_${n}`, `weblink_${n}`])];
const DK_SEARCH = /^https:\/\/www\.digikey\.co\.za\/en\/products\/result\?keywords=(.+)$/;

/** DigiKey's own product page in place of a search, where DigiKey answers. */
async function withDigikeyPages(fixes: LinkFix[], ask: (pn: string) => Promise<string | null>): Promise<LinkFix[]> {
  for (const f of fixes) {
    for (const ch of f.changes) {
      const m = ch.to.match(DK_SEARCH);
      if (!m) continue;
      const page = await ask(decodeURIComponent(m[1])).catch(() => null);
      if (page) ch.to = page;
      else f.why += '; DigiKey could not be asked, so its link is a search for the part number';
    }
  }
  return fixes;
}

const askDigikey = async (pn: string) => (await searchDigikey(pn))?.productUrl ?? null;

async function listFixes(db: { query: (s: string, p?: any[]) => Promise<any> }, serials?: string[]) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS.join(', ')} FROM inventory WHERE deleted IS NOT TRUE${serials ? ' AND serial_number = ANY($1::text[]) ORDER BY serial_number FOR UPDATE' : ' ORDER BY serial_number'}`,
    serials ? [serials] : []);
  return { rows, fixes: rows.map(linkFixFor).filter(Boolean) as LinkFix[] };
}

export function registerLinkCleanupRoutes(app: Express): void {
  app.get('/api/inventory/data-checks', async (_req, res) => {
    try {
      const cols = ['serial_number', 'name', 'description', ...[1, 2, 3, 4, 5].flatMap((n) => [`man_pn_${n}`, `sup_pn_${n}`, `weblink_${n}`])];
      const { rows } = await query(`SELECT ${cols.join(', ')} FROM inventory WHERE deleted IS NOT TRUE ORDER BY serial_number`);
      res.json({ checks: checkItems(rows) });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/inventory/link-cleanup', async (_req, res) => {
    try {
      const { fixes } = await listFixes({ query: (s, p) => query(s, p) });
      res.json({ fixes: await withDigikeyPages(fixes, askDigikey) });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/inventory/link-cleanup/apply', requirePermission('inventory.update'), async (req: any, res) => {
    const list = Array.isArray(req.body?.items) ? req.body.items.filter((i: any) => typeof i?.serialNumber === 'string') : [];
    if (!list.length || list.length > 2000) return res.status(400).json({ error: 'items must be a list of 1 to 2000.' });
    const seen = new Map<string, Record<string, string>>(list.map((i: any) => [i.serialNumber, i.from && typeof i.from === 'object' ? i.from : {}]));
    const who = req.user?.email || 'unknown';
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows, fixes } = await listFixes(client, [...seen.keys()]);
      const byItem = new Map(rows.map((r: any) => [r.serial_number, r]));
      await withDigikeyPages(fixes, askDigikey);
      const applied: string[] = []; const skipped: Array<{ serialNumber: string; reason: string }> = [];
      for (const f of fixes) {
        const r: any = byItem.get(f.serialNumber);
        const from = seen.get(f.serialNumber) ?? {};
        // Only what the person saw: every link it showed must still be as it was.
        if (Object.entries(from).some(([field, v]) => String(r?.[field] ?? '').trim() !== String(v ?? '').trim())) { skipped.push({ serialNumber: f.serialNumber, reason: 'Its links changed since the list was made.' }); continue; }
        if (!f.changes.length && !f.supplier) { skipped.push({ serialNumber: f.serialNumber, reason: 'Needs a person.' }); continue; }
        const sets = f.changes.map((ch, i) => `"${ch.field}" = $${i + 2}`); // fields come from the fixed weblink_1..5 list
        const params: any[] = [f.serialNumber, ...f.changes.map((ch) => ch.to)];
        if (f.supplier) { params.push(f.supplier); sets.push(`supplier = $${params.length}`); }
        await client.query(`UPDATE inventory SET ${sets.join(', ')} WHERE serial_number = $1`, params);
        await client.query(
          `INSERT INTO user_activity_logs (user_email, action, entity_type, entity_id, details, status) VALUES ((SELECT email FROM users WHERE email = $1), 'FIX_WEB_LINKS', 'Item', $2, $3, 'SUCCESS')`,
          [who, f.serialNumber, JSON.stringify({ changes: f.changes, supplier: f.supplier ?? null, why: f.why, by: who })]
        );
        applied.push(f.serialNumber);
      }
      for (const s of seen.keys()) if (!fixes.some((f) => f.serialNumber === s)) skipped.push({ serialNumber: s, reason: 'Nothing to fix any more.' });
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
