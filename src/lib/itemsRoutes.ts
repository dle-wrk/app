// Inventory-items surface extracted from server.ts. Owns the /api/items/* CRUD
// (list, get, create, patch, put, soft-delete, restore), the bulk upsert, three
// status-repair maintenance endpoints, and the category-based code generator.
//
// The PATCH handler carries a lot of verbose logging and a retry loop for a
// real, previously-hit Neon read-after-write consistency issue — preserved
// verbatim because tuning it out would just re-open that bug.
//
// The Zod ItemSchema + ALLOWED_ITEM_FIELDS list lives here too: outside this
// module the item shape isn't referenced, and keeping it colocated with the
// handlers that build dynamic SQL from it makes the whitelist harder to drift.

import type { Express } from 'express';
import { z } from 'zod';
import { query, queryOne } from './db';

const ItemSchema = z.object({
  serial_number: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  value: z.string().optional(),
  size: z.string().optional(),
  package: z.string().optional(),
  tolerance: z.string().optional(),
  type: z.string().optional(),
  footprint: z.string().optional(),
  comment: z.string().optional(),
  datasheet: z.string().optional(),
  project: z.string().optional(),
  packaging: z.string().optional(),
  stock: z.number().int().optional(),
  qty_per_pcb: z.number().optional(),
  low_stock_lvl: z.number().int().optional(),
  current_cost_dollar: z.number().optional(),
  bulk_price_usd: z.number().optional(),
  bulk_price_zar: z.number().optional(),
  last_order_qty: z.number().int().optional(),
  last_order_date: z.string().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'BOOKED OUT', 'DISCONTINUED']).optional(),
  man_pn_1: z.string().optional(),
  man_pn_2: z.string().optional(),
  man_pn_3: z.string().optional(),
  man_pn_4: z.string().optional(),
  man_pn_5: z.string().optional(),
  sup_pn_1: z.string().optional(),
  sup_pn_2: z.string().optional(),
  sup_pn_3: z.string().optional(),
  sup_pn_4: z.string().optional(),
  sup_pn_5: z.string().optional(),
  weblink_1: z.string().optional(),
  weblink_2: z.string().optional(),
  weblink_3: z.string().optional(),
  weblink_4: z.string().optional(),
  weblink_5: z.string().optional(),
});

const ALLOWED_ITEM_FIELDS = Object.keys(ItemSchema.shape).filter(k => k !== 'serial_number');

export function registerItemsRoutes(app: Express): void {
  // Route-order caveat: this module registers GET /api/items/products and GET
  // /api/items/generate-code/:category BEFORE the parametric GET
  // /api/items/:serial_number/references so Express doesn't fall through to
  // the wrong handler. POST /api/items/restore/:serial_number is registered
  // before POST /api/items for the same reason.

  app.get('/api/items', async (req, res) => {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : null;
    const offset = parseInt(req.query.offset as string) || 0;

    if ((req.query.limit && isNaN(limit!)) || isNaN(offset)) {
      return res.status(400).json({ error: 'Invalid limit or offset' });
    }

    try {
      let items;
      if (limit !== null) {
        const { rows } = await query('SELECT * FROM inventory WHERE deleted != true ORDER BY serial_number LIMIT $1 OFFSET $2', [limit, offset]);
        items = rows;
      } else {
        const { rows } = await query('SELECT * FROM inventory WHERE deleted != true ORDER BY serial_number');
        items = rows;
      }

      const { rows: countRows } = await query<{ count: string }>('SELECT COUNT(*) as count FROM inventory WHERE deleted != true');
      const total = parseInt(countRows[0].count, 10);

      if (req.headers['x-request-format'] === 'paginated' || limit !== null) {
        res.json({
          data: items,
          pagination: { total, limit: limit ?? total, offset },
        });
      } else {
        res.json(items);
      }
    } catch (err: any) {
      console.error('ERROR IN GET /api/items:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Products catalogue served under /api/items/products so the frontend's
  // shared "items table" can render finished goods alongside stock items using
  // the same list widget. Shape mirrors an inventory row closely enough that
  // the client doesn't need to branch.
  app.get('/api/items/products', async (_req, res) => {
    try {
      const { rows } = await query(`SELECT * FROM production_products ORDER BY model_number`);
      const items = rows.map((r: any) => ({
        partNumber: r.model_number,
        name: r.description,
        description: r.description,
        manufacturer: '',
        stockLevel: 999999,
        price: r.selling_price || 0,
        category: r.category || 'Product',
        status: 'ACTIVE',
        supplier: 'Internal Production',
      }));
      res.json(items);
    } catch (err: any) {
      console.error('ERROR IN GET /api/items/products:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.patch('/api/items/:serial_number', async (req, res) => {
    const serial_number = decodeURIComponent(req.params.serial_number);
    console.log(`[PATCH ITEM] ==========================================`);
    console.log(`[PATCH ITEM] req received for serial_number: ${serial_number}`);
    console.log(`[PATCH ITEM] body fields:`, Object.keys(req.body));
    console.log(`[PATCH ITEM] body:`, JSON.stringify(req.body));

    const result = ItemSchema.partial().safeParse(req.body);
    if (!result.success) {
      console.error(`[PATCH ITEM] safety validation failed:`, result.error.format());
      return res.status(400).json({ error: 'Invalid update data', details: result.error.format() });
    }
    const data = result.data as Record<string, any>;
    console.log(`[PATCH ITEM] after validation, data fields:`, Object.keys(data));
    console.log(`[PATCH ITEM] ALLOWED_ITEM_FIELDS:`, ALLOWED_ITEM_FIELDS);
    console.log(`[PATCH ITEM] status in data?:`, data.status);

    const sets: string[] = [];
    const vals: any[] = [];
    for (const key of ALLOWED_ITEM_FIELDS) {
      if (data[key] !== undefined) {
        sets.push(`"${key}" = $${sets.length + 1}`);
        vals.push(data[key]);
        if (key === 'status') {
          console.log(`[PATCH ITEM] including status field: ${data[key]}`);
        }
      }
    }
    if (sets.length === 0) {
      console.warn(`[PATCH ITEM] no fields to update.`);
      return res.status(400).json({ error: 'no fields to update' });
    }
    const sqlText = `UPDATE inventory SET ${sets.join(', ')} WHERE serial_number = $${sets.length + 1}`;
    vals.push(serial_number);
    console.log(`[PATCH ITEM] executing update: ${sets.join(', ')}`);
    console.log(`[PATCH ITEM] full SQL: ${sqlText}`);
    try {
      const { rowCount } = await query(sqlText, vals);
      console.log(`[PATCH ITEM] update complete. rowCount: ${rowCount}`);
      if (rowCount === 0) {
        console.warn(`[PATCH ITEM] item not found: ${serial_number}`);
        return res.status(404).json({ error: 'item not found' });
      }

      // Neon serverless can lag on read-after-write; retry until we see the
      // status we just wrote (or hit the attempt cap). Removing this loop
      // silently reopens a bug where the UI immediately re-reads and shows
      // the pre-update value.
      let row = null;
      let attempts = 0;
      const maxAttempts = 15;
      const baseDelay = 500;

      console.log(`[PATCH ITEM] verifying update with retry logic... requesting updates for: ${JSON.stringify(data)}`);

      for (attempts = 0; attempts < maxAttempts; attempts++) {
        if (attempts > 0) {
          const delay = baseDelay * Math.pow(1.5, attempts - 1);
          console.log(`[PATCH ITEM] retry attempt ${attempts}/${maxAttempts}, waiting ${Math.round(delay)}ms`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }

        row = await queryOne<any>(`SELECT * FROM inventory WHERE serial_number = $1`, [serial_number]);

        if (!row) {
          console.warn(`[PATCH ITEM] item not found on attempt ${attempts + 1}`);
          continue;
        }

        // Check if status specifically was updated
        if (data.status) {
          console.log(`[PATCH ITEM] attempt ${attempts + 1}: expected status=${data.status}, got=${row.status}`);
          if (String(row.status).toUpperCase().trim() === String(data.status).toUpperCase().trim()) {
            console.log(`[PATCH ITEM] ✓ STATUS MATCH! Data persisted correctly`);
            break;
          }
        } else {
          // No status update requested — just return the row.
          console.log(`[PATCH ITEM] no status update requested, returning row`);
          break;
        }
      }

      if (!row) {
        console.error(`[PATCH ITEM] failed to retrieve item after ${attempts + 1} attempts`);
        return res.status(500).json({ error: 'Failed to retrieve updated item' });
      }

      console.log(`[PATCH ITEM] final status in DB: ${row?.status}, took ${attempts + 1} attempt(s)`);

      // Force one final read with a longer delay to ensure persistence
      await new Promise(resolve => setTimeout(resolve, 1000));
      const finalRow = await queryOne<any>(`SELECT * FROM inventory WHERE serial_number = $1`, [serial_number]);

      if (finalRow) {
        console.log(`[PATCH ITEM] FINAL VERIFICATION: status in DB is ${finalRow.status}`);
        res.json(finalRow);
      } else {
        res.json(row);
      }
    } catch (err: any) {
      console.error(`[PATCH ITEM] ERROR during update:`, err.message);
      res.status(500).json({ error: 'Failed to update item', details: err.message });
    }
  });

  app.put('/api/items/:serial_number', async (req, res) => {
    const serial_number = decodeURIComponent(req.params.serial_number);
    const result = ItemSchema.partial().safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: 'Invalid update data', details: result.error.format() });
    }
    const data = result.data as Record<string, any>;
    const sets: string[] = [];
    const vals: any[] = [];
    for (const key of ALLOWED_ITEM_FIELDS) {
      if (data[key] !== undefined) {
        sets.push(`"${key}" = $${sets.length + 1}`);
        vals.push(data[key]);
      }
    }
    if (sets.length === 0) return res.status(400).json({ error: 'no fields to update' });
    const sqlText = `UPDATE inventory SET ${sets.join(', ')} WHERE serial_number = $${sets.length + 1}`;
    vals.push(serial_number);
    const { rowCount } = await query(sqlText, vals);
    if (rowCount === 0) return res.status(404).json({ error: 'item not found' });
    const row = await queryOne(`SELECT * FROM inventory WHERE serial_number = $1`, [serial_number]);
    res.json(row);
  });

  // Placeholder: the delete-confirmation dialog asks whether the item is
  // referenced by BOMs / pick notes so users get warned instead of silently
  // orphaning data. Real reference-counting isn't implemented yet, so the
  // endpoint reports "no references" without erroring — the confirmation
  // still works, just without the extra warning.
  app.get('/api/items/:serial_number/references', async (req, res) => {
    const serial_number = decodeURIComponent(req.params.serial_number);
    console.log(`[CHECK REFERENCES] checking references for item: ${serial_number}`);

    try {
      const references: { [key: string]: number } = {};
      res.json({ references, hasReferences: false });
    } catch (err: any) {
      console.error(`[CHECK REFERENCES] ERROR:`, err.message);
      // Return empty references on error rather than 500
      res.json({ references: {}, hasReferences: false });
    }
  });

  // Soft delete: flip the `deleted` flag so the row stays in the DB and can
  // be restored via POST /api/items/restore. Every list query filters on
  // `deleted != true`, so hidden rows disappear from the UI without losing
  // audit-worthy fields like historical stock counts.
  app.delete('/api/items/:serial_number', async (req, res) => {
    const serial_number = decodeURIComponent(req.params.serial_number);
    console.log(`[DELETE ITEM] =========== DELETE REQUEST RECEIVED ===========`);
    console.log(`[DELETE ITEM] serial_number: ${serial_number}`);
    console.log(`[DELETE ITEM] method: ${req.method}`);
    console.log(`[DELETE ITEM] path: ${req.path}`);

    try {
      console.log(`[DELETE ITEM] executing soft delete query...`);
      const { rowCount } = await query(`UPDATE inventory SET deleted = true WHERE serial_number = $1`, [serial_number]);
      console.log(`[DELETE ITEM] query result - rowCount: ${rowCount}`);

      if (rowCount === 0) {
        console.warn(`[DELETE ITEM] item not found: ${serial_number}`);
        return res.status(404).json({ error: 'item not found' });
      }

      console.log(`[DELETE ITEM] successfully soft-deleted item: ${serial_number}`);
      res.json({ success: true, message: `Item ${serial_number} deleted successfully` });
    } catch (err: any) {
      console.error(`[DELETE ITEM] ERROR deleting item:`, err.message);
      res.status(500).json({ error: 'Failed to delete item', details: err.message });
    }
  });

  app.post('/api/items/restore/:serial_number', async (req, res) => {
    const serial_number = decodeURIComponent(req.params.serial_number);
    const itemData = req.body;
    console.log(`[RESTORE ITEM] request to restore item: ${serial_number}`);

    try {
      if (!itemData || typeof itemData !== 'object') {
        return res.status(400).json({ error: 'Invalid item data for restore' });
      }

      const fields: string[] = [];
      const vals: any[] = [];
      let paramCount = 1;

      for (const key of ALLOWED_ITEM_FIELDS) {
        if (itemData[key] !== undefined && itemData[key] !== null) {
          fields.push(`"${key}" = $${paramCount}`);
          vals.push(itemData[key]);
          paramCount++;
        }
      }

      if (fields.length === 0) {
        return res.status(400).json({ error: 'No valid fields to restore' });
      }

      const sqlText = `INSERT INTO inventory (serial_number, ${fields.map(f => f.split(' = ')[0]).join(', ')})
                       VALUES ($${paramCount}, ${fields.map((_, i) => `$${i + 1}`).join(', ')})
                       ON CONFLICT (serial_number) DO UPDATE SET ${fields.join(', ')}`;
      vals.push(serial_number);

      console.log(`[RESTORE ITEM] executing restore query with item: ${serial_number}`);
      const { rowCount } = await query(sqlText, vals);

      if (rowCount === 0) {
        console.warn(`[RESTORE ITEM] failed to restore item: ${serial_number}`);
        return res.status(500).json({ error: 'Failed to restore item' });
      }

      const row = await queryOne(`SELECT * FROM inventory WHERE serial_number = $1`, [serial_number]);
      console.log(`[RESTORE ITEM] successfully restored item: ${serial_number}`);
      res.json({ success: true, message: `Item ${serial_number} restored successfully`, item: row });
    } catch (err: any) {
      console.error(`[RESTORE ITEM] ERROR restoring item:`, err.message);
      res.status(500).json({ error: 'Failed to restore item', details: err.message });
    }
  });

  app.post('/api/items', async (req, res) => {
    const result = ItemSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: 'Invalid item data', details: result.error.format() });
    }
    const data: any = result.data;
    const fields: string[] = [];
    const placeholders: string[] = [];
    const vals: any[] = [];
    const updates: string[] = [];

    fields.push('serial_number');
    placeholders.push('$1');
    vals.push(data.serial_number);

    let idx = 2;
    for (const key of ALLOWED_ITEM_FIELDS) {
      if (data[key] !== undefined) {
        fields.push(`"${key}"`);
        placeholders.push(`$${idx}`);
        vals.push(data[key]);
        updates.push(`"${key}" = EXCLUDED."${key}"`);
        idx++;
      }
    }

    let sqlText;
    if (updates.length > 0) {
      sqlText = `INSERT INTO inventory (${fields.join(', ')}) VALUES (${placeholders.join(', ')})
                 ON CONFLICT(serial_number) DO UPDATE SET ${updates.join(', ')}`;
    } else {
      sqlText = `INSERT INTO inventory (${fields.join(', ')}) VALUES (${placeholders.join(', ')})
                 ON CONFLICT(serial_number) DO NOTHING`;
    }
    try {
      await query(sqlText, vals);
      const row = await queryOne(`SELECT * FROM inventory WHERE serial_number = $1`, [data.serial_number]);
      res.status(201).json(row);
    } catch (err: any) {
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  app.post('/api/items/bulk', async (req, res) => {
    const result = z.array(ItemSchema).safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: 'Invalid items array', details: result.error.format() });
    }
    const items = result.data;

    // PARTIAL upsert: only touch the columns actually present in each payload row.
    // Previously this wrote ALL columns (missing ones -> NULL), so a price-only
    // update would wipe an item's name, stock, part numbers, etc. Building
    // per-row SQL from the provided keys preserves untouched columns. (It also
    // uses Postgres $1..$N placeholders — the old code used SQLite-style '?',
    // which was invalid here and made every bulk update fail with a swallowed 500.)
    const upsert = async (rows: any[]) => {
      for (const data of rows) {
        const keys = ['serial_number', ...ALLOWED_ITEM_FIELDS].filter(f => (data as any)[f] !== undefined && (data as any)[f] !== null);
        if (!keys.includes('serial_number')) continue; // PK is required to target a row
        const cols = keys.map(f => `"${f}"`).join(', ');
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
        const updateCols = keys.filter(f => f !== 'serial_number');
        const vals = keys.map(f => (data as any)[f]);
        if (updateCols.length === 0) {
          // Only the PK was supplied — make sure the row exists but change nothing.
          await query(`INSERT INTO inventory ("serial_number") VALUES ($1) ON CONFLICT (serial_number) DO NOTHING`, [data.serial_number]);
          continue;
        }
        const updates = updateCols.map(f => `"${f}" = EXCLUDED."${f}"`).join(', ');
        await query(
          `INSERT INTO inventory (${cols}) VALUES (${placeholders}) ON CONFLICT (serial_number) DO UPDATE SET ${updates}`,
          vals
        );
      }
    };

    try {
      await upsert(items);
      res.json({ ok: true, count: items.length });
    } catch (err: any) {
      console.error('ERROR IN POST /api/items/bulk:', err.message);
      res.status(500).json({ error: 'Internal Server Error', details: err.message });
    }
  });

  // Set every row whose status is NULL / empty / not in the enum to ACTIVE.
  // Manual repair path — called from the UI after imports that leave the field
  // blank.
  app.post('/api/items/set-all-active', async (_req, res) => {
    try {
      const sqlText = `UPDATE inventory SET status = 'ACTIVE' WHERE status IS NULL OR status = '' OR status NOT IN ('ACTIVE', 'INACTIVE', 'BOOKED OUT', 'DISCONTINUED')`;
      const { rowCount } = await query(sqlText);
      console.log(`[POST /api/items/set-all-active] Update complete. ${rowCount} items set to ACTIVE.`);
      res.json({ ok: true, updatedCount: rowCount });
    } catch (err: any) {
      console.error('ERROR IN POST /api/items/set-all-active:', err.message);
      res.status(500).json({ error: 'Internal Server Error', details: err.message });
    }
  });

  app.post('/api/items/fix-status', async (_req, res) => {
    try {
      // Split into three passes so the UI can show which class of rows was
      // affected (NULL vs empty vs invalid) — a single OR-ed UPDATE would
      // still work but wouldn't produce that breakdown.
      const fixNull = await query(`UPDATE inventory SET status = 'ACTIVE' WHERE status IS NULL`);
      const fixEmpty = await query(`UPDATE inventory SET status = 'ACTIVE' WHERE status = ''`);
      const fixInvalid = await query(`UPDATE inventory SET status = 'ACTIVE' WHERE status NOT IN ('ACTIVE', 'INACTIVE', 'BOOKED OUT', 'DISCONTINUED')`);

      const total = (fixNull.rowCount || 0) + (fixEmpty.rowCount || 0) + (fixInvalid.rowCount || 0);
      console.log(`[POST /api/items/fix-status] Fixed ${total} items with invalid status. NULL: ${fixNull.rowCount}, Empty: ${fixEmpty.rowCount}, Invalid: ${fixInvalid.rowCount}`);
      res.json({ ok: true, fixedCount: total, details: { nullFixed: fixNull.rowCount, emptyFixed: fixEmpty.rowCount, invalidFixed: fixInvalid.rowCount } });
    } catch (err: any) {
      console.error('ERROR IN POST /api/items/fix-status:', err.message);
      res.status(500).json({ error: 'Internal Server Error', details: err.message });
    }
  });

  app.post('/api/items/fix-inactive', async (_req, res) => {
    try {
      const { rowCount } = await query(`UPDATE inventory SET status = 'ACTIVE' WHERE status = 'INACTIVE'`);
      console.log(`[POST /api/items/fix-inactive] Fixed ${rowCount} INACTIVE items to ACTIVE`);
      res.json({ ok: true, fixedCount: rowCount });
    } catch (err: any) {
      console.error('ERROR IN POST /api/items/fix-inactive:', err.message);
      res.status(500).json({ error: 'Internal Server Error', details: err.message });
    }
  });

  // Suggest the next code for a category by scanning the highest-numbered
  // existing serial with the same 3-letter prefix and incrementing it.
  // Category "BUTTON" → prefix "BUT" → last row "BUT-003" → next "BUT-004".
  app.get('/api/items/generate-code/:category', async (req, res) => {
    try {
      const category = req.params.category?.toUpperCase();
      if (!category) {
        return res.status(400).json({ error: 'Category is required' });
      }

      const prefix = category.substring(0, 3).toUpperCase();

      const { rows } = await query(`
        SELECT serial_number FROM inventory
        WHERE serial_number LIKE $1
        ORDER BY serial_number DESC
        LIMIT 1
      `, [`${prefix}%`]);

      let nextNumber = 1;
      if (rows.length > 0) {
        const lastCode = rows[0].serial_number;
        const match = lastCode.match(/(\d+)$/);
        if (match) {
          nextNumber = parseInt(match[1], 10) + 1;
        }
      }

      const newCode = `${prefix}-${String(nextNumber).padStart(3, '0')}`;

      console.log(`[GET /api/items/generate-code] Generated ${newCode} for category ${category}`);
      res.json({ code: newCode, category, nextNumber });
    } catch (err: any) {
      console.error('ERROR IN GET /api/items/generate-code:', err.message);
      res.status(500).json({ error: 'Internal Server Error', details: err.message });
    }
  });
}
