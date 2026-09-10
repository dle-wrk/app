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
import { pool, query, queryOne } from './db';
import { nextDocNumber } from './bookkeeping-db';

// Client-order row → camelCase JSON. Only ONE definition of the shape lives
// here — every endpoint that returns a client_order (list, create, update,
// verify-toggle, doc-upload) funnels through this so the fields never drift.
// verification_doc_data is intentionally never emitted; the caller downloads
// the bytea via GET /:id/document instead.
function mapClientOrder(row: any) {
  return {
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
    verificationDocMime: row.verification_doc_mime,
    verificationDocFilename: row.verification_doc_filename,
    verificationDocUploadedAt: row.verification_doc_uploaded_at,
    hasVerificationDoc: !!row.verification_doc_mime,
    verified: !!row.verified,
    verifiedAt: row.verified_at,
    verifiedBy: row.verified_by,
    createdAt: row.created_at,
  };
}

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
      // Deliberately excludes verification_doc_data from the list response —
      // the bytea can be many MB and every list-consumer only needs to know
      // whether a doc is present (via the mime/filename/uploaded_at fields).
      // Callers that need the raw bytes go through GET /:id/document.
      const { rows } = await query(`SELECT id, client_id, order_number, order_date, required_date, status, currency, subtotal, tax, total, notes, verification_doc_mime, verification_doc_filename, verification_doc_uploaded_at, verified, verified_at, verified_by, created_at FROM client_orders ORDER BY id`);
      res.json(rows.map(mapClientOrder));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Creates a client order + (optionally) its line items in one round-trip.
  // orderNumber is now optional — when omitted, the server generates
  // "SO-YYYY-NNNN" via the sales_order_seq sequence so the UI doesn't have to
  // guess. If `items` is present, each row is inserted under the new order id
  // inside the same transaction so a failure part-way through doesn't leave
  // an order with missing lines.
  app.post('/api/client-orders', async (req, res) => {
    const { clientId, orderNumber, orderDate, requiredDate, status, currency, subtotal, tax, total, notes, items } = req.body;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const finalOrderNumber = orderNumber || await nextDocNumber(client, 'SO', 'sales_order_seq');
      const { rows: orderRows } = await client.query(
        `INSERT INTO client_orders (client_id, order_number, order_date, required_date, status, currency, subtotal, tax, total, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [clientId || null, finalOrderNumber, orderDate || null, requiredDate || null, status || 'DRAFT', currency || 'ZAR', subtotal || 0, tax || 0, total || 0, notes || null]
      );
      const order = orderRows[0];

      if (Array.isArray(items)) {
        for (const it of items) {
          await client.query(
            `INSERT INTO client_order_items (client_order_id, part_number, description, quantity, unit_price, line_total)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [order.id, it.partNumber || null, it.description || '', it.quantity || 1, it.unitPrice || 0, it.lineTotal || 0]
          );
        }
      }

      await client.query('COMMIT');
      res.status(201).json(mapClientOrder(order));
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
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
      res.json(mapClientOrder(row));
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
  // Verification document (POP / customer PO attachment) — one document per
  // client_order. Upload accepts base64-encoded JSON (same shape the bill-
  // receipt scan flow uses) rather than multipart, keeping the whole
  // clientsRoutes surface middleware-free. The download endpoint streams the
  // raw bytea back with the stored mime type so a browser can open it inline.
  // ---------------------------------------------------------------------------
  app.post('/api/client-orders/:id/document', async (req, res) => {
    const id = parseInt(req.params.id);
    const { data, mime, filename } = req.body ?? {};
    if (!data || !mime || !filename) {
      return res.status(400).json({ error: 'data (base64), mime, and filename are required' });
    }
    // 20MB ceiling matches the express.json limit set in server.ts; anything
    // bigger would have been rejected by the body parser before reaching us.
    // Reject early with a clearer message when we can spot it in-handler.
    const buf = Buffer.from(data, 'base64');
    if (buf.length === 0) return res.status(400).json({ error: 'data decoded to zero bytes' });
    if (buf.length > 20 * 1024 * 1024) return res.status(413).json({ error: 'document exceeds 20MB limit' });

    try {
      const row = await queryOne(
        `UPDATE client_orders SET
           verification_doc_data = $1,
           verification_doc_mime = $2,
           verification_doc_filename = $3,
           verification_doc_uploaded_at = now()
         WHERE id = $4 RETURNING *`,
        [buf, mime, filename, id]
      );
      if (!row) return res.status(404).json({ error: 'client order not found' });
      res.status(201).json(mapClientOrder(row));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/client-orders/:id/document', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      const row = await queryOne(
        `SELECT verification_doc_data, verification_doc_mime, verification_doc_filename FROM client_orders WHERE id = $1`,
        [id]
      );
      if (!row || !row.verification_doc_data) return res.status(404).json({ error: 'no document on this order' });
      res.setHeader('Content-Type', row.verification_doc_mime || 'application/octet-stream');
      // inline so the browser opens PDFs / images in a new tab; add filename
      // as an attachment hint so Save-As uses the original name.
      res.setHeader('Content-Disposition', `inline; filename="${(row.verification_doc_filename || 'document').replace(/"/g, '')}"`);
      res.send(row.verification_doc_data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/client-orders/:id/document', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      // Also un-verifies the order — a verify tick against a document that no
      // longer exists is meaningless, and forcing the reviewer to re-tick
      // after a new upload is the safer default.
      const row = await queryOne(
        `UPDATE client_orders SET
           verification_doc_data = NULL,
           verification_doc_mime = NULL,
           verification_doc_filename = NULL,
           verification_doc_uploaded_at = NULL,
           verified = FALSE,
           verified_at = NULL,
           verified_by = NULL
         WHERE id = $1 RETURNING *`,
        [id]
      );
      if (!row) return res.status(404).json({ error: 'client order not found' });
      res.json(mapClientOrder(row));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/client-orders/:id/verify', async (req, res) => {
    const id = parseInt(req.params.id);
    const { verified, verifiedBy } = req.body ?? {};
    if (typeof verified !== 'boolean') {
      return res.status(400).json({ error: 'verified (boolean) is required' });
    }
    try {
      // When flipping true, stamp timestamp + user; when flipping false, clear
      // both so the audit trail doesn't stale-lock old signatures onto a doc
      // that's since been re-uploaded.
      const row = await queryOne(
        verified
          ? `UPDATE client_orders SET verified = TRUE, verified_at = now(), verified_by = $1 WHERE id = $2 AND verification_doc_data IS NOT NULL RETURNING *`
          : `UPDATE client_orders SET verified = FALSE, verified_at = NULL, verified_by = NULL WHERE id = $2 RETURNING *`,
        [verifiedBy || null, id]
      );
      if (!row) {
        // Distinguish "no such order" from "can't verify without a doc"
        // — the latter is a common mistake worth calling out explicitly.
        const exists = await queryOne(`SELECT id FROM client_orders WHERE id = $1`, [id]);
        if (!exists) return res.status(404).json({ error: 'client order not found' });
        return res.status(400).json({ error: 'cannot verify: no document attached' });
      }
      res.json(mapClientOrder(row));
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
