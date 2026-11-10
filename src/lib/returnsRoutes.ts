// Customer returns (RMA): a return is opened (from an invoice, or on its
// own), received when the goods arrive, each line inspected and given an
// outcome, then closed. Closing puts restocked lines back into stock (No
// location, ready to put away) as INBOUND movements "Return RMA-…", and can
// raise a DRAFT credit note against the invoice for the lines being credited,
// at the invoiced price, to check and issue as usual (issuing posts it; it
// doesn't restock again: the return already did).
//
//   GET  /api/returns                     every return
//   GET  /api/returns/:id                 one, with its lines
//   POST /api/returns                     {clientId, invoiceId?, reason?, notes?, lines: [{partNumber?, description, quantity, serialNumbers?, reason?, unitPrice?, taxRateId?, invoiceItemId?}]}
//   PUT  /api/returns/:id                 edit while open or received: same body as POST, lines with their id kept (and their outcome)
//   POST /api/returns/:id/receive         the goods have arrived
//   PUT  /api/returns/:id/lines/:lineId   {outcome, outcomeNote?}: RESTOCK | SCRAP | REPAIR | REPLACE | CREDIT
//   POST /api/returns/:id/close           {creditNote: boolean}
//   POST /api/returns/:id/cancel
//   DELETE /api/returns/:id               open, received or cancelled only (a closed one has changed stock or the books)
//   POST /api/returns/:id/repaired        {lines: [{lineId, charge?, note?}], noteType: DELIVERY | COLLECTION, invoice: boolean}
//
// Repairs: closing a return puts its REPAIR lines "in repair". When they are
// fixed, "repaired" raises a DRAFT delivery or collection note to send them
// back (the customer's own goods, so it takes nothing from stock) and, for
// any line with a repair charge (each, excl. VAT; 0 for warranty), a DRAFT
// invoice to check and send as usual. Lines not picked stay in repair.

import type { Express } from 'express';
import { pool, query, exec } from './db';
import { computeDocumentTotals, computeLineTotals, nextDocNumber } from './bookkeeping-db';
import { adjustStock, resolveTaxPercent } from './bookkeeping-routes';

export const OUTCOMES = ['RESTOCK', 'SCRAP', 'REPAIR', 'REPLACE', 'CREDIT'] as const;
export type Outcome = typeof OUTCOMES[number];
/** Outcomes the customer is credited for, and those that go back into stock. */
export const CREDITED: Outcome[] = ['RESTOCK', 'SCRAP', 'CREDIT'];
export const RESTOCKED: Outcome[] = ['RESTOCK'];

export async function ensureReturnsSchema(run: (sql: string) => Promise<void> = exec): Promise<void> {
  await run(`CREATE SEQUENCE IF NOT EXISTS return_seq`);
  await run(`CREATE TABLE IF NOT EXISTS customer_returns (
    id SERIAL PRIMARY KEY,
    number TEXT UNIQUE NOT NULL,
    client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RECEIVED', 'CLOSED', 'CANCELLED')),
    reason TEXT, notes TEXT,
    credit_note_id INTEGER,
    created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    received_at TIMESTAMPTZ, closed_at TIMESTAMPTZ, closed_by TEXT
  )`);
  await run(`CREATE TABLE IF NOT EXISTS customer_return_lines (
    id SERIAL PRIMARY KEY,
    return_id INTEGER NOT NULL REFERENCES customer_returns(id) ON DELETE CASCADE,
    part_number TEXT, description TEXT NOT NULL DEFAULT '',
    quantity NUMERIC(12,2) NOT NULL CHECK (quantity > 0),
    serial_numbers TEXT, reason TEXT,
    unit_price NUMERIC(14,4) NOT NULL DEFAULT 0, tax_rate_id INTEGER, invoice_item_id INTEGER,
    outcome TEXT CHECK (outcome IN ('RESTOCK', 'SCRAP', 'REPAIR', 'REPLACE', 'CREDIT')),
    outcome_note TEXT
  )`);
  await run(`ALTER TABLE customer_return_lines
    ADD COLUMN IF NOT EXISTS repair_status TEXT CHECK (repair_status IN ('IN_REPAIR', 'REPAIRED')),
    ADD COLUMN IF NOT EXISTS repair_charge NUMERIC(14,2),
    ADD COLUMN IF NOT EXISTS repair_note TEXT,
    ADD COLUMN IF NOT EXISTS repaired_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS repair_invoice_id INTEGER,
    ADD COLUMN IF NOT EXISTS repair_dispatch_id INTEGER`);
}

/** The invoice and delivery-note wording for a repaired line. */
export function repairDescription(l: { description?: string | null; part_number?: string | null; serial_numbers?: string | null }): string {
  return `Repair: ${l.description || l.part_number || 'returned item'}${l.serial_numbers ? ` (S/N ${l.serial_numbers})` : ''}`;
}

/** Checks the lines picked as repaired against the return's lines. */
export function repairPlan(lines: any[], picks: Array<{ lineId: any; charge?: any; note?: any }>) {
  if (!picks.length) throw fail(400, 'Choose what has been repaired.');
  const seen = new Set<number>();
  return picks.map((p) => {
    const id = Number(p.lineId);
    const line = lines.find((l) => l.id === id);
    if (!line) throw fail(404, 'Line not found.');
    if (seen.has(id)) throw fail(400, 'A line is picked twice.');
    seen.add(id);
    if (line.repair_status !== 'IN_REPAIR') throw fail(409, `${line.part_number || line.description} isn't waiting for repair.`);
    const charge = p.charge === '' || p.charge == null ? 0 : Number(p.charge);
    if (!Number.isFinite(charge) || charge < 0) throw fail(400, "A repair charge can't be negative.");
    return { line, charge: Math.round(charge * 100) / 100, note: String(p.note ?? '').trim() || null };
  });
}

const httpError = (res: any, err: any) => res.status(err.status || 500).json({ error: err.message });
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
type Db = { query: (s: string, p?: any[]) => Promise<any> };

async function loadReturn(db: Db, id: number) {
  const { rows: [r] } = await db.query(
    `SELECT r.*, c.client_name, i.invoice_number, cn.credit_note_number FROM customer_returns r LEFT JOIN clients c ON c.id = r.client_id
       LEFT JOIN invoices i ON i.id = r.invoice_id LEFT JOIN credit_notes cn ON cn.id = r.credit_note_id WHERE r.id = $1`, [id]);
  if (!r) return null;
  const { rows: lines } = await db.query(
    `SELECT l.*, ri.invoice_number AS repair_invoice_number, rd.note_number AS repair_dispatch_number, rd.note_type AS repair_dispatch_type
       FROM customer_return_lines l LEFT JOIN invoices ri ON ri.id = l.repair_invoice_id LEFT JOIN dispatch_notes rd ON rd.id = l.repair_dispatch_id
      WHERE l.return_id = $1 ORDER BY l.id`, [id]);
  return { ...r, lines };
}

/**
 * Edits an open or received return in the caller's transaction: customer,
 * invoice, reason and lines. Lines sent with their id are updated (keeping
 * the outcome already given), new ones added, and lines left out removed.
 */
export async function editReturn(client: Db, id: number, b: any, lines: any[]) {
  const { rows: [r] } = await client.query(`SELECT number, status FROM customer_returns WHERE id = $1 FOR UPDATE`, [id]);
  if (!r) throw fail(404, 'Return not found.');
  if (r.status !== 'OPEN' && r.status !== 'RECEIVED') throw fail(409, `This return is ${r.status.toLowerCase()}, so it can't be edited.`);
  let clientId = b.clientId ? Number(b.clientId) : null;
  if (b.invoiceId) {
    const { rows: [inv] } = await client.query(`SELECT client_id FROM invoices WHERE id = $1`, [Number(b.invoiceId)]);
    if (!inv) throw fail(400, 'That invoice no longer exists.');
    clientId = inv.client_id;
  }
  await client.query(`UPDATE customer_returns SET client_id = $2, invoice_id = $3, reason = $4, notes = COALESCE($5, notes) WHERE id = $1`,
    [id, clientId, b.invoiceId ? Number(b.invoiceId) : null, String(b.reason ?? '').trim() || null, b.notes === undefined ? null : String(b.notes).trim()]);
  const { rows: existing } = await client.query(`SELECT id FROM customer_return_lines WHERE return_id = $1`, [id]);
  const keep = new Set<number>();
  for (const l of lines) {
    const vals = [String(l.partNumber ?? '').trim() || null, String(l.description ?? '').trim(), Number(l.quantity), String(l.serialNumbers ?? '').trim() || null, String(l.reason ?? '').trim() || null,
      Number(l.unitPrice) || 0, l.taxRateId ? Number(l.taxRateId) : null, l.invoiceItemId ? Number(l.invoiceItemId) : null];
    const lineId = Number(l.id);
    if (lineId && existing.some((e: any) => e.id === lineId)) {
      keep.add(lineId);
      await client.query(`UPDATE customer_return_lines SET part_number = $3, description = $4, quantity = $5, serial_numbers = $6, reason = $7, unit_price = $8, tax_rate_id = $9, invoice_item_id = $10 WHERE id = $1 AND return_id = $2`,
        [lineId, id, ...vals]);
    } else {
      await client.query(`INSERT INTO customer_return_lines (return_id, part_number, description, quantity, serial_numbers, reason, unit_price, tax_rate_id, invoice_item_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [id, ...vals]);
    }
  }
  const gone = existing.map((e: any) => e.id).filter((x: number) => !keep.has(x));
  if (gone.length) await client.query(`DELETE FROM customer_return_lines WHERE return_id = $1 AND id = ANY($2::int[])`, [id, gone]);
  return { number: r.number as string, removed: gone.length };
}

/** Closes a return in the caller's transaction: restocks, and the draft credit note if asked. */
export async function closeReturn(client: Db, id: number, who: string, withCredit: boolean) {
  const r = await loadReturn(client, id);
  if (!r) throw fail(404, 'Return not found.');
  if (r.status !== 'RECEIVED') throw fail(409, r.status === 'OPEN' ? 'Mark it received before closing it.' : `This return is ${r.status.toLowerCase()}.`);
  const undecided = r.lines.filter((l: any) => !l.outcome);
  if (undecided.length) throw fail(400, `Give every line an outcome first (${undecided.length} left).`);
  const restocked: Array<{ partNumber: string; qty: number }> = [];
  for (const l of r.lines) {
    if (RESTOCKED.includes(l.outcome) && l.part_number) {
      const qty = Math.round(Number(l.quantity));
      await adjustStock(client, l.part_number, qty, 'INBOUND', `Return ${r.number}`);
      restocked.push({ partNumber: l.part_number, qty });
    }
  }
  let creditNote: { id: number; number: string } | null = null;
  const credited = r.lines.filter((l: any) => CREDITED.includes(l.outcome) && Number(l.unit_price) > 0);
  if (withCredit && credited.length) {
    const computed = await Promise.all(credited.map(async (l: any) => {
      const taxPct = await resolveTaxPercent(l.tax_rate_id ?? null);
      return { l, ...computeLineTotals({ quantity: Number(l.quantity), unitPrice: Number(l.unit_price), taxRatePercent: taxPct, taxInclusive: false } as any) };
    }));
    const { subtotal, taxTotal, total } = computeDocumentTotals(computed, 0);
    const number = await nextDocNumber(client as any, 'CN', 'credit_note_seq');
    const { rows: [cur] } = r.invoice_id ? await client.query(`SELECT currency FROM invoices WHERE id = $1`, [r.invoice_id]) : { rows: [{ currency: 'ZAR' }] };
    const { rows: [cn] } = await client.query(
      `INSERT INTO credit_notes (credit_note_number, invoice_id, client_id, credit_date, reason, currency, subtotal, tax_total, total, notes)
       VALUES ($1, $2, $3, CURRENT_DATE, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [number, r.invoice_id, r.client_id, `Return ${r.number}${r.reason ? `: ${r.reason}` : ''}`, cur?.currency || 'ZAR', subtotal, taxTotal, total, `From return ${r.number}. Restocked lines were returned to stock by the return.`]);
    for (const c of computed) {
      await client.query(
        `INSERT INTO credit_note_items (credit_note_id, invoice_item_id, part_number, description, quantity, unit_price, tax_rate_id, tax_amount, line_total, restock)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false)`,
        [cn.id, c.l.invoice_item_id, c.l.part_number, c.l.description || c.l.part_number || 'Returned item', c.l.quantity, c.l.unit_price, c.l.tax_rate_id, c.taxAmount, c.lineTotal]);
    }
    creditNote = { id: cn.id, number };
  }
  await client.query(`UPDATE customer_returns SET status = 'CLOSED', closed_at = now(), closed_by = $2, credit_note_id = $3 WHERE id = $1`, [id, who, creditNote?.id ?? null]);
  const { rowCount: inRepair } = await client.query(`UPDATE customer_return_lines SET repair_status = 'IN_REPAIR' WHERE return_id = $1 AND outcome = 'REPAIR'`, [id]);
  await client.query(
    `INSERT INTO user_activity_logs (user_email, action, entity_type, entity_id, details, status) VALUES ((SELECT email FROM users WHERE email = $1), 'CLOSE_RETURN', 'Return', $2, $3, 'SUCCESS')`,
    [who, r.number, JSON.stringify({ restocked, creditNote: creditNote?.number ?? null, by: who })]);
  return { number: r.number as string, restocked, creditNote, inRepair: inRepair ?? 0 };
}

/** Repaired lines go back: a draft delivery/collection note, and a draft invoice for any charge. In the caller's transaction. */
export async function sendRepairsBack(client: Db, id: number, who: string, body: any) {
  const r = await loadReturn(client, id);
  if (!r) throw fail(404, 'Return not found.');
  if (r.status !== 'CLOSED') throw fail(409, 'Close the return first; its repair lines then wait here until they are fixed.');
  const noteType = body?.noteType === 'COLLECTION' ? 'COLLECTION' : 'DELIVERY';
  const picked = repairPlan(r.lines, Array.isArray(body?.lines) ? body.lines : []);
  const { rows: [c] } = await client.query(`SELECT client_name, contact_name, address, payment_terms_days FROM clients WHERE id = $1`, [r.client_id]);
  const { rows: [src] } = r.invoice_id ? await client.query(`SELECT currency FROM invoices WHERE id = $1`, [r.invoice_id]) : { rows: [] as any[] };
  const notes = picked.filter((p) => p.note).map((p) => `${p.line.part_number || p.line.description}: ${p.note}`);
  const today = new Date().toISOString().slice(0, 10);

  let invoice: { id: number; number: string } | null = null;
  const charged = picked.filter((p) => p.charge > 0);
  if (body?.invoice !== false && charged.length) {
    const { rows: [def] } = await client.query(`SELECT id FROM tax_rates WHERE is_default ORDER BY id LIMIT 1`);
    const computed = await Promise.all(charged.map(async (p) => {
      const taxRateId = p.line.tax_rate_id ?? def?.id ?? null;
      const taxPct = await resolveTaxPercent(taxRateId);
      return { p, taxRateId, ...computeLineTotals({ quantity: Number(p.line.quantity), unitPrice: p.charge, taxRatePercent: taxPct, taxInclusive: false } as any) };
    }));
    const { subtotal, taxTotal, total } = computeDocumentTotals(computed, 0);
    const number = await nextDocNumber(client as any, 'INV', 'invoice_seq');
    const terms = c?.payment_terms_days != null ? Number(c.payment_terms_days) : null;
    const due = terms != null ? new Date(Date.now() + terms * 86_400_000).toISOString().slice(0, 10) : null;
    const { rows: [inv] } = await client.query(
      `INSERT INTO invoices (invoice_number, client_id, invoice_date, due_date, status, currency, subtotal, tax_total, discount_total, total, balance_due, notes)
       VALUES ($1, $2, $3, $4, 'DRAFT', $5, $6, $7, 0, $8, $8, $9) RETURNING id`,
      [number, r.client_id, today, due, src?.currency || 'ZAR', subtotal, taxTotal, total, [`Repair of return ${r.number}${r.invoice_number ? ` (from ${r.invoice_number})` : ''}.`, ...notes].join('\n')]);
    for (const x of computed) {
      await client.query(
        `INSERT INTO invoice_items (invoice_id, part_number, description, quantity, unit_price, tax_rate_id, tax_amount, line_total, deduct_stock, tax_inclusive)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, false)`,
        [inv.id, x.p.line.part_number, repairDescription(x.p.line), x.p.line.quantity, x.p.charge, x.taxRateId, x.taxAmount, x.lineTotal]);
    }
    invoice = { id: inv.id, number };
  }

  const isDelivery = noteType === 'DELIVERY';
  const noteNumber = await nextDocNumber(client as any, isDelivery ? 'DN' : 'CN', isDelivery ? 'dispatch_delivery_seq' : 'dispatch_collection_seq');
  const { rows: [dn] } = await client.query(
    `INSERT INTO dispatch_notes (note_number, note_type, client_id, client_order_id, invoice_id, note_date, scheduled_date, status, contact_person, address, carrier, reference, notes)
     VALUES ($1, $2, $3, NULL, $4, $5, NULL, 'DRAFT', $6, $7, NULL, $8, $9) RETURNING id`,
    [noteNumber, noteType, r.client_id, invoice?.id ?? null, today, c?.contact_name || null, c?.address || null, r.number,
      [`Repaired under return ${r.number}: the customer's own goods going back${isDelivery ? '' : ', for them to collect'}.`, ...notes].join('\n')]);
  for (const p of picked) {
    await client.query(
      `INSERT INTO dispatch_note_items (dispatch_note_id, part_number, description, quantity, serial_numbers, deduct_stock) VALUES ($1, $2, $3, $4, $5, false)`,
      [dn.id, p.line.part_number, repairDescription(p.line), p.line.quantity, p.line.serial_numbers]);
    await client.query(
      `UPDATE customer_return_lines SET repair_status = 'REPAIRED', repair_charge = $2, repair_note = $3, repaired_at = now(), repair_invoice_id = $4, repair_dispatch_id = $5 WHERE id = $1`,
      [p.line.id, p.charge, p.note, p.charge > 0 ? invoice?.id ?? null : null, dn.id]);
  }
  const dispatch = { id: dn.id as number, number: noteNumber, type: noteType };
  await client.query(
    `INSERT INTO user_activity_logs (user_email, action, entity_type, entity_id, details, status) VALUES ((SELECT email FROM users WHERE email = $1), 'RETURN_REPAIRED', 'Return', $2, $3, 'SUCCESS')`,
    [who, r.number, JSON.stringify({ lines: picked.map((p) => ({ part: p.line.part_number, qty: Number(p.line.quantity), charge: p.charge })), invoice: invoice?.number ?? null, dispatch: noteNumber, by: who })]);
  return { number: r.number as string, repaired: picked.length, invoice, dispatch };
}

export function registerReturnsRoutes(app: Express): void {
  app.get('/api/returns', async (_req, res) => {
    try {
      const { rows } = await query(`SELECT r.*, c.client_name, i.invoice_number, cn.credit_note_number,
          (SELECT COUNT(*)::int FROM customer_return_lines l WHERE l.return_id = r.id) AS lines,
          (SELECT COUNT(*)::int FROM customer_return_lines l WHERE l.return_id = r.id AND l.repair_status = 'IN_REPAIR') AS in_repair
        FROM customer_returns r LEFT JOIN clients c ON c.id = r.client_id LEFT JOIN invoices i ON i.id = r.invoice_id
        LEFT JOIN credit_notes cn ON cn.id = r.credit_note_id ORDER BY r.id DESC LIMIT 300`);
      res.json(rows);
    } catch (err) { httpError(res, err); }
  });

  app.get('/api/returns/:id', async (req, res) => {
    try {
      const r = await loadReturn({ query: (s, p) => query(s, p) }, parseInt(req.params.id));
      if (!r) return res.status(404).json({ error: 'Return not found.' });
      res.json(r);
    } catch (err) { httpError(res, err); }
  });

  app.post('/api/returns', async (req: any, res) => {
    const b = req.body ?? {};
    const lines = (Array.isArray(b.lines) ? b.lines : []).filter((l: any) => Number(l.quantity) > 0 && (l.partNumber || l.description));
    if (!b.clientId && !b.invoiceId) return res.status(400).json({ error: 'Choose the customer or the invoice.' });
    if (!lines.length) return res.status(400).json({ error: 'Add what is being returned.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let clientId = b.clientId ? Number(b.clientId) : null;
      if (b.invoiceId) {
        const { rows: [inv] } = await client.query(`SELECT client_id, status FROM invoices WHERE id = $1`, [Number(b.invoiceId)]);
        if (!inv) throw fail(400, 'That invoice no longer exists.');
        clientId = inv.client_id;
      }
      const number = await nextDocNumber(client as any, 'RMA', 'return_seq');
      const { rows: [r] } = await client.query(
        `INSERT INTO customer_returns (number, client_id, invoice_id, reason, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [number, clientId, b.invoiceId ? Number(b.invoiceId) : null, String(b.reason ?? '').trim() || null, String(b.notes ?? '').trim() || null, req.user?.email ?? null]);
      for (const l of lines) {
        await client.query(
          `INSERT INTO customer_return_lines (return_id, part_number, description, quantity, serial_numbers, reason, unit_price, tax_rate_id, invoice_item_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [r.id, String(l.partNumber ?? '').trim() || null, String(l.description ?? '').trim(), Number(l.quantity), String(l.serialNumbers ?? '').trim() || null, String(l.reason ?? '').trim() || null,
            Number(l.unitPrice) || 0, l.taxRateId ? Number(l.taxRateId) : null, l.invoiceItemId ? Number(l.invoiceItemId) : null]);
      }
      await client.query('COMMIT');
      res.status(201).json({ id: r.id, number });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      httpError(res, err);
    } finally { client.release(); }
  });

  app.put('/api/returns/:id', async (req: any, res) => {
    const id = parseInt(req.params.id);
    const b = req.body ?? {};
    const lines = (Array.isArray(b.lines) ? b.lines : []).filter((l: any) => Number(l.quantity) > 0 && (l.partNumber || l.description));
    if (!b.clientId && !b.invoiceId) return res.status(400).json({ error: 'Choose the customer or the invoice.' });
    if (!lines.length) return res.status(400).json({ error: 'Add what is being returned.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await editReturn(client, id, b, lines);
      await client.query('COMMIT');
      res.json(out);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      httpError(res, err);
    } finally { client.release(); }
  });

  app.post('/api/returns/:id/receive', async (req, res) => {
    try {
      const { rowCount } = await query(`UPDATE customer_returns SET status = 'RECEIVED', received_at = now() WHERE id = $1 AND status = 'OPEN'`, [parseInt(req.params.id)]);
      if (!rowCount) return res.status(409).json({ error: 'Only an open return can be received.' });
      res.json({ ok: true });
    } catch (err) { httpError(res, err); }
  });

  app.put('/api/returns/:id/lines/:lineId', async (req, res) => {
    const outcome = req.body?.outcome ?? null;
    if (outcome !== null && !(OUTCOMES as readonly string[]).includes(outcome)) return res.status(400).json({ error: 'Unknown outcome.' });
    try {
      const { rows: [r] } = await query(`SELECT status FROM customer_returns WHERE id = $1`, [parseInt(req.params.id)]);
      if (!r) return res.status(404).json({ error: 'Return not found.' });
      if (r.status === 'CLOSED' || r.status === 'CANCELLED') return res.status(409).json({ error: `This return is ${r.status.toLowerCase()}.` });
      const { rowCount } = await query(`UPDATE customer_return_lines SET outcome = $3, outcome_note = $4 WHERE id = $2 AND return_id = $1`,
        [parseInt(req.params.id), parseInt(req.params.lineId), outcome, String(req.body?.outcomeNote ?? '').trim() || null]);
      if (!rowCount) return res.status(404).json({ error: 'Line not found.' });
      res.json({ ok: true });
    } catch (err) { httpError(res, err); }
  });

  app.post('/api/returns/:id/close', async (req: any, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT 1 FROM customer_returns WHERE id = $1 FOR UPDATE`, [parseInt(req.params.id)]);
      const out = await closeReturn(client, parseInt(req.params.id), req.user?.email ?? 'unknown', req.body?.creditNote !== false);
      await client.query('COMMIT');
      res.json(out);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      httpError(res, err);
    } finally { client.release(); }
  });

  app.post('/api/returns/:id/repaired', async (req: any, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT 1 FROM customer_returns WHERE id = $1 FOR UPDATE`, [parseInt(req.params.id)]);
      const out = await sendRepairsBack(client, parseInt(req.params.id), req.user?.email ?? 'unknown', req.body);
      await client.query('COMMIT');
      res.json(out);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      httpError(res, err);
    } finally { client.release(); }
  });

  // Delete: only a return that hasn't touched stock or the books (open, received or cancelled).
  app.delete('/api/returns/:id', async (req, res) => {
    try {
      const { rows: [r] } = await query(`SELECT number, status FROM customer_returns WHERE id = $1`, [parseInt(req.params.id)]);
      if (!r) return res.status(404).json({ error: 'Return not found.' });
      if (r.status === 'CLOSED') return res.status(409).json({ error: `${r.number} is closed: it has already changed stock or the books (restock, credit note, repairs), so it can't be deleted.` });
      await query(`DELETE FROM customer_returns WHERE id = $1 AND status <> 'CLOSED'`, [parseInt(req.params.id)]);
      res.json({ ok: true, number: r.number });
    } catch (err) { httpError(res, err); }
  });

  app.post('/api/returns/:id/cancel', async (req, res) => {
    try {
      const { rowCount } = await query(`UPDATE customer_returns SET status = 'CANCELLED' WHERE id = $1 AND status IN ('OPEN', 'RECEIVED')`, [parseInt(req.params.id)]);
      if (!rowCount) return res.status(409).json({ error: 'Only an open or received return can be cancelled.' });
      res.json({ ok: true });
    } catch (err) { httpError(res, err); }
  });
}
