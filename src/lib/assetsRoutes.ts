// Assets surface extracted from server.ts. Owns the two physical-artefact
// tables and their CRUD:
//   - sub_assemblies    (pre-built assemblies used inside larger builds;
//                        a parent/child pair with a quantity, grouped by
//                        assembly_name — think "5 x R100 lives inside the
//                        RF filter sub-assembly")
//   - fielded_assets    (serial-numbered units installed at customer sites,
//                        tagged with client_id, status, install date, etc.)
//
// These are distinct from bom_structures (see inventoryMetadataRoutes) —
// bom_structures is the raw parent-child part graph; sub_assemblies is a
// human-named grouping over that graph, and fielded_assets are actual
// units in customer hands (post-shipment) with warranty/status tracking.
//
// PUT semantics: every field is COALESCE'd against its current value so a
// partial payload only overwrites what it names.
//
// Dependencies deliberately narrow: only the shared db helpers.

import type { Express } from 'express';
import { query, queryOne } from './db';

export function registerAssetsRoutes(app: Express): void {
  // ---------------------------------------------------------------------------
  // Sub-Assemblies
  // ---------------------------------------------------------------------------
  app.get('/api/sub-assemblies', async (_req, res) => {
    try {
      const { rows } = await query('SELECT * FROM sub_assemblies ORDER BY id');
      res.json(rows.map((row: any) => ({
        id: row.id,
        assemblyName: row.assembly_name,
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

  app.post('/api/sub-assemblies', async (req, res) => {
    const { assemblyName, parentPartNumber, childPartNumber, quantity, description } = req.body;
    if (!assemblyName) return res.status(400).json({ error: 'assemblyName is required' });

    try {
      const row = await queryOne(
        `INSERT INTO sub_assemblies (assembly_name, parent_part_number, child_part_number, quantity, description)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [assemblyName, parentPartNumber || null, childPartNumber || null, quantity || 1, description || null]
      );
      res.status(201).json({
        id: row?.id,
        assemblyName: row?.assembly_name,
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

  app.put('/api/sub-assemblies/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const { assemblyName, parentPartNumber, childPartNumber, quantity, description } = req.body;
    try {
      const row = await queryOne(
        `UPDATE sub_assemblies SET
           assembly_name = COALESCE($1, assembly_name),
           parent_part_number = COALESCE($2, parent_part_number),
           child_part_number = COALESCE($3, child_part_number),
           quantity = COALESCE($4, quantity),
           description = COALESCE($5, description)
           WHERE id = $6 RETURNING *`,
        [assemblyName ?? null, parentPartNumber ?? null, childPartNumber ?? null, quantity ?? null, description ?? null, id]
      );
      if (!row) return res.status(404).json({ error: 'sub assembly not found' });
      res.json({
        id: row.id,
        assemblyName: row.assembly_name,
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

  app.delete('/api/sub-assemblies/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      const { rowCount } = await query('DELETE FROM sub_assemblies WHERE id = $1', [id]);
      if (rowCount === 0) return res.status(404).json({ error: 'sub assembly not found' });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------------------
  // Fielded Assets (deployed units at customer sites)
  // ---------------------------------------------------------------------------
  app.get('/api/fielded-assets', async (_req, res) => {
    try {
      const { rows } = await query('SELECT * FROM fielded_assets ORDER BY id');
      res.json(rows.map((row: any) => ({
        id: row.id,
        clientId: row.client_id,
        assetTag: row.asset_tag,
        serialNumber: row.serial_number,
        installedDate: row.installed_date,
        status: row.status,
        location: row.location,
        notes: row.notes,
        createdAt: row.created_at,
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/fielded-assets', async (req, res) => {
    const { clientId, assetTag, serialNumber, installedDate, status, location, notes } = req.body;
    if (!assetTag) return res.status(400).json({ error: 'assetTag is required' });

    try {
      const row = await queryOne(
        `INSERT INTO fielded_assets (client_id, asset_tag, serial_number, installed_date, status, location, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [clientId || null, assetTag, serialNumber || null, installedDate || null, status || 'ACTIVE', location || null, notes || null]
      );
      res.status(201).json({
        id: row?.id,
        clientId: row?.client_id,
        assetTag: row?.asset_tag,
        serialNumber: row?.serial_number,
        installedDate: row?.installed_date,
        status: row?.status,
        location: row?.location,
        notes: row?.notes,
        createdAt: row?.created_at,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/fielded-assets/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const { clientId, assetTag, serialNumber, installedDate, status, location, notes } = req.body;
    try {
      const row = await queryOne(
        `UPDATE fielded_assets SET
           client_id = COALESCE($1, client_id),
           asset_tag = COALESCE($2, asset_tag),
           serial_number = COALESCE($3, serial_number),
           installed_date = COALESCE($4, installed_date),
           status = COALESCE($5, status),
           location = COALESCE($6, location),
           notes = COALESCE($7, notes)
           WHERE id = $8 RETURNING *`,
        [clientId ?? null, assetTag ?? null, serialNumber ?? null, installedDate ?? null, status ?? null, location ?? null, notes ?? null, id]
      );
      if (!row) return res.status(404).json({ error: 'fielded asset not found' });
      res.json({
        id: row.id,
        clientId: row.client_id,
        assetTag: row.asset_tag,
        serialNumber: row.serial_number,
        installedDate: row.installed_date,
        status: row.status,
        location: row.location,
        notes: row.notes,
        createdAt: row.created_at,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/fielded-assets/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      const { rowCount } = await query('DELETE FROM fielded_assets WHERE id = $1', [id]);
      if (rowCount === 0) return res.status(404).json({ error: 'fielded asset not found' });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
