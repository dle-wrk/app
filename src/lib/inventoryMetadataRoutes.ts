// Inventory-metadata surface extracted from server.ts. Owns two tables
// that describe *how parts relate and move*, as distinct from the parts
// themselves (which live in itemsRoutes) or physical assemblies (which
// live in assetsRoutes):
//
//   - bom_structures    (the raw parent-child part graph: for a given
//                        parent part number, which child part numbers go
//                        into it and how many. A single flat table, one
//                        row per parent/child pair — no nesting, no
//                        assembly grouping. Sub-assemblies layer a
//                        human-named grouping on top; see assetsRoutes.)
//
//   - stock_ledger      (append-log of stock movements — one row per IN
//                        / OUT / TRANSFER event with quantity, date, and
//                        a free-form reference. Separate from the
//                        transactions table used by the BOOK-IN modal in
//                        App.tsx; stock_ledger is for warehouse-level
//                        movements imported from external systems, while
//                        `transactions` records user-facing bookings.)
//
// PUT semantics: every field is COALESCE'd against its current value so
// a partial payload only overwrites what it names.
//
// Dependencies deliberately narrow: only the shared db helpers.

import type { Express } from 'express';
import { query, queryOne } from './db';

export function registerInventoryMetadataRoutes(app: Express): void {
  // ---------------------------------------------------------------------------
  // BOM Structures (flat parent/child part graph)
  // ---------------------------------------------------------------------------
  app.get('/api/bom-structures', async (_req, res) => {
    try {
      const { rows } = await query('SELECT * FROM bom_structures ORDER BY id');
      res.json(rows.map((row: any) => ({
        id: row.id,
        parentPartNumber: row.parent_part_number,
        childPartNumber: row.child_part_number,
        quantity: row.quantity,
        description: row.description,
        createdAt: row.created_at,
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/bom-structures', async (req, res) => {
    const { parentPartNumber, childPartNumber, quantity, description } = req.body;
    if (!parentPartNumber || !childPartNumber) {
      return res.status(400).json({ error: 'parentPartNumber and childPartNumber are required' });
    }

    try {
      const row = await queryOne(
        `INSERT INTO bom_structures (parent_part_number, child_part_number, quantity, description)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [parentPartNumber, childPartNumber, quantity || 1, description || null]
      );
      res.status(201).json({
        id: row?.id,
        parentPartNumber: row?.parent_part_number,
        childPartNumber: row?.child_part_number,
        quantity: row?.quantity,
        description: row?.description,
        createdAt: row?.created_at,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/bom-structures/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const { parentPartNumber, childPartNumber, quantity, description } = req.body;
    try {
      const row = await queryOne(
        `UPDATE bom_structures SET
           parent_part_number = COALESCE($1, parent_part_number),
           child_part_number = COALESCE($2, child_part_number),
           quantity = COALESCE($3, quantity),
           description = COALESCE($4, description)
           WHERE id = $5 RETURNING *`,
        [parentPartNumber ?? null, childPartNumber ?? null, quantity ?? null, description ?? null, id]
      );
      if (!row) return res.status(404).json({ error: 'BOM structure not found' });
      res.json({
        id: row.id,
        parentPartNumber: row.parent_part_number,
        childPartNumber: row.child_part_number,
        quantity: row.quantity,
        description: row.description,
        createdAt: row.created_at,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/bom-structures/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      const { rowCount } = await query('DELETE FROM bom_structures WHERE id = $1', [id]);
      if (rowCount === 0) return res.status(404).json({ error: 'BOM structure not found' });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------------------
  // Stock Ledger (append-log of stock movements; distinct from `transactions`)
  // ---------------------------------------------------------------------------
  app.get('/api/stock-ledger', async (_req, res) => {
    try {
      const { rows } = await query('SELECT * FROM stock_ledger ORDER BY movement_date DESC');
      res.json(rows.map((row: any) => ({
        id: row.id,
        itemSerialNumber: row.item_serial_number,
        movementType: row.movement_type,
        quantity: row.quantity,
        movementDate: row.movement_date,
        reference: row.reference,
        notes: row.notes,
        createdAt: row.created_at,
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/stock-ledger', async (req, res) => {
    const { itemSerialNumber, movementType, quantity, movementDate, reference, notes } = req.body;
    if (!movementType) return res.status(400).json({ error: 'movementType is required' });

    try {
      const row = await queryOne(
        `INSERT INTO stock_ledger (item_serial_number, movement_type, quantity, movement_date, reference, notes)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [itemSerialNumber || null, movementType, quantity || 0, movementDate || null, reference || null, notes || null]
      );
      res.status(201).json({
        id: row?.id,
        itemSerialNumber: row?.item_serial_number,
        movementType: row?.movement_type,
        quantity: row?.quantity,
        movementDate: row?.movement_date,
        reference: row?.reference,
        notes: row?.notes,
        createdAt: row?.created_at,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/stock-ledger/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const { itemSerialNumber, movementType, quantity, movementDate, reference, notes } = req.body;
    try {
      const row = await queryOne(
        `UPDATE stock_ledger SET
           item_serial_number = COALESCE($1, item_serial_number),
           movement_type = COALESCE($2, movement_type),
           quantity = COALESCE($3, quantity),
           movement_date = COALESCE($4, movement_date),
           reference = COALESCE($5, reference),
           notes = COALESCE($6, notes)
           WHERE id = $7 RETURNING *`,
        [itemSerialNumber ?? null, movementType ?? null, quantity ?? null, movementDate ?? null, reference ?? null, notes ?? null, id]
      );
      if (!row) return res.status(404).json({ error: 'stock ledger entry not found' });
      res.json({
        id: row.id,
        itemSerialNumber: row.item_serial_number,
        movementType: row.movement_type,
        quantity: row.quantity,
        movementDate: row.movement_date,
        reference: row.reference,
        notes: row.notes,
        createdAt: row.created_at,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/stock-ledger/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      const { rowCount } = await query('DELETE FROM stock_ledger WHERE id = $1', [id]);
      if (rowCount === 0) return res.status(404).json({ error: 'stock ledger entry not found' });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
