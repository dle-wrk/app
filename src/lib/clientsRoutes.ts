// Clients surface extracted from server.ts. Owns three tables and the CRUD
// on all of them:
//   - clients                 (customer records; NOT the older `customers` table)
//   - client_orders           (sales orders, header row)
//   - client_order_items      (line items on a client_order)
//
// A note on the clients vs customers table: every bookkeeping foreign key
// (invoices.client_id, payments_received.client_id, dispatch_notes.client_id)
// points at `clients`. There is a legacy `customers` table that predates the
// bookkeeping surface. Reading customers here — as we did briefly — meant a
// dispatch note pointing at clients.id = 5 could not be resolved and rendered
// as "Unassigned". Reads AND writes have to target `clients` for the client
// to be referenceable from the bookkeeping side; keep them aligned.
//
// PUT semantics: every field is a COALESCE onto its current value so a
// partial payload only overwrites the fields it names. The bookkeeping
// tabs and CustomersTab rely on this for their small edits.
//
// Dependencies deliberately narrow: only the shared db helpers.

import type { Express } from 'express';
import { query, queryOne } from './db';

export function registerClientsRoutes(app: Express): void {
  // ---------------------------------------------------------------------------
  // Clients (customers) — see file header on the clients-vs-customers split.
  // ---------------------------------------------------------------------------
  app.get('/api/clients', async (_req, res) => {
    try {
      const { rows } = await query('SELECT * FROM clients ORDER BY id');
      res.json(rows.map((row: any) => ({
        id: row.id,
        clientName: row.client_name,
        contactName: row.contact_name,
        email: row.email,
        phone: row.phone,
        address: row.address,
        vatNumber: row.vat_number,
        status: row.status,
        createdAt: row.created_at,
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/clients', async (req, res) => {
    const { clientName, contactName, email, phone, address, vatNumber, status } = req.body;
    if (!clientName) return res.status(400).json({ error: 'clientName is required' });

    try {
      const row = await queryOne(
        `INSERT INTO clients (client_name, contact_name, email, phone, address, vat_number, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [clientName, contactName || null, email || null, phone || null, address || null, vatNumber || null, status || 'ACTIVE']
      );
      res.status(201).json({
        id: row?.id,
        clientName: row?.client_name,
        contactName: row?.contact_name,
        email: row?.email,
        phone: row?.phone,
        address: row?.address,
        vatNumber: row?.vat_number,
        status: row?.status,
        createdAt: row?.created_at,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/clients/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const { clientName, contactName, email, phone, address, vatNumber, status } = req.body;
    try {
      const row = await queryOne(
        `UPDATE clients SET
           client_name = COALESCE($1, client_name),
           contact_name = COALESCE($2, contact_name),
           email = COALESCE($3, email),
           phone = COALESCE($4, phone),
           address = COALESCE($5, address),
           vat_number = COALESCE($6, vat_number),
           status = COALESCE($7, status)
           WHERE id = $8 RETURNING *`,
        [clientName ?? null, contactName ?? null, email ?? null, phone ?? null, address ?? null, vatNumber ?? null, status ?? null, id]
      );
      if (!row) return res.status(404).json({ error: 'client not found' });
      res.json({
        id: row.id,
        clientName: row.client_name,
        contactName: row.contact_name,
        email: row.email,
        phone: row.phone,
        address: row.address,
        vatNumber: row.vat_number,
        status: row.status,
        createdAt: row.created_at,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/clients/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      const { rowCount } = await query('DELETE FROM clients WHERE id = $1', [id]);
      if (rowCount === 0) return res.status(404).json({ error: 'client not found' });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------------------
  // Client Orders (sales order headers)
  // ---------------------------------------------------------------------------
  app.get('/api/client-orders', async (_req, res) => {
    try {
      const { rows } = await query('SELECT * FROM client_orders ORDER BY id');
      res.json(rows.map((row: any) => ({
        id: row.id,
        clientId: row.client_id,
        orderNumber: row.order_number,
        orderDate: row.order_date,
        requiredDate: row.required_date,
        status: row.status,
        currency: row.currency,
        subtotal: row.subtotal,
        tax: row.tax,
        total: row.total,
        notes: row.notes,
        createdAt: row.created_at,
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/client-orders', async (req, res) => {
    const { clientId, orderNumber, orderDate, requiredDate, status, currency, subtotal, tax, total, notes } = req.body;
    if (!orderNumber) return res.status(400).json({ error: 'orderNumber is required' });

    try {
      const row = await queryOne(
        `INSERT INTO client_orders (client_id, order_number, order_date, required_date, status, currency, subtotal, tax, total, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [clientId || null, orderNumber, orderDate || null, requiredDate || null, status || 'DRAFT', currency || 'ZAR', subtotal || 0, tax || 0, total || 0, notes || null]
      );
      res.status(201).json({
        id: row?.id,
        clientId: row?.client_id,
        orderNumber: row?.order_number,
        orderDate: row?.order_date,
        requiredDate: row?.required_date,
        status: row?.status,
        currency: row?.currency,
        subtotal: row?.subtotal,
        tax: row?.tax,
        total: row?.total,
        notes: row?.notes,
        createdAt: row?.created_at,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/client-orders/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const { clientId, orderNumber, orderDate, requiredDate, status, currency, subtotal, tax, total, notes } = req.body;
    try {
      const row = await queryOne(
        `UPDATE client_orders SET
           client_id = COALESCE($1, client_id),
           order_number = COALESCE($2, order_number),
           order_date = COALESCE($3, order_date),
           required_date = COALESCE($4, required_date),
           status = COALESCE($5, status),
           currency = COALESCE($6, currency),
           subtotal = COALESCE($7, subtotal),
           tax = COALESCE($8, tax),
           total = COALESCE($9, total),
           notes = COALESCE($10, notes)
           WHERE id = $11 RETURNING *`,
        [clientId ?? null, orderNumber ?? null, orderDate ?? null, requiredDate ?? null, status ?? null, currency ?? null, subtotal ?? null, tax ?? null, total ?? null, notes ?? null, id]
      );
      if (!row) return res.status(404).json({ error: 'client order not found' });
      res.json({
        id: row.id,
        clientId: row.client_id,
        orderNumber: row.order_number,
        orderDate: row.order_date,
        requiredDate: row.required_date,
        status: row.status,
        currency: row.currency,
        subtotal: row.subtotal,
        tax: row.tax,
        total: row.total,
        notes: row.notes,
        createdAt: row.created_at,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/client-orders/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      const { rowCount } = await query('DELETE FROM client_orders WHERE id = $1', [id]);
      if (rowCount === 0) return res.status(404).json({ error: 'client order not found' });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------------------
  // Client Order Items (line items on a client_order)
  // ---------------------------------------------------------------------------
  app.get('/api/client-order-items', async (_req, res) => {
    try {
      const { rows } = await query('SELECT * FROM client_order_items ORDER BY id');
      res.json(rows.map((row: any) => ({
        id: row.id,
        clientOrderId: row.client_order_id,
        partNumber: row.part_number,
        description: row.description,
        quantity: row.quantity,
        unitPrice: row.unit_price,
        lineTotal: row.line_total,
        createdAt: row.created_at,
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/client-order-items', async (req, res) => {
    const { clientOrderId, partNumber, description, quantity, unitPrice, lineTotal } = req.body;
    if (!description) return res.status(400).json({ error: 'description is required' });

    try {
      const row = await queryOne(
        `INSERT INTO client_order_items (client_order_id, part_number, description, quantity, unit_price, line_total)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [clientOrderId || null, partNumber || null, description, quantity || 1, unitPrice || 0, lineTotal || 0]
      );
      res.status(201).json({
        id: row?.id,
        clientOrderId: row?.client_order_id,
        partNumber: row?.part_number,
        description: row?.description,
        quantity: row?.quantity,
        unitPrice: row?.unit_price,
        lineTotal: row?.line_total,
        createdAt: row?.created_at,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/client-order-items/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const { clientOrderId, partNumber, description, quantity, unitPrice, lineTotal } = req.body;
    try {
      const row = await queryOne(
        `UPDATE client_order_items SET
           client_order_id = COALESCE($1, client_order_id),
           part_number = COALESCE($2, part_number),
           description = COALESCE($3, description),
           quantity = COALESCE($4, quantity),
           unit_price = COALESCE($5, unit_price),
           line_total = COALESCE($6, line_total)
           WHERE id = $7 RETURNING *`,
        [clientOrderId ?? null, partNumber ?? null, description ?? null, quantity ?? null, unitPrice ?? null, lineTotal ?? null, id]
      );
      if (!row) return res.status(404).json({ error: 'client order item not found' });
      res.json({
        id: row.id,
        clientOrderId: row.client_order_id,
        partNumber: row.part_number,
        description: row.description,
        quantity: row.quantity,
        unitPrice: row.unit_price,
        lineTotal: row.line_total,
        createdAt: row.created_at,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/client-order-items/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      const { rowCount } = await query('DELETE FROM client_order_items WHERE id = $1', [id]);
      if (rowCount === 0) return res.status(404).json({ error: 'client order item not found' });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
