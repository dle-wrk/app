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
//   POST /api/returns/:id/receive         the goods have arrived
//   PUT  /api/returns/:id/lines/:lineId   {outcome, outcomeNote?}: RESTOCK | SCRAP | REPAIR | REPLACE | CREDIT
//   POST /api/returns/:id/close           {creditNote: boolean}
//   POST /api/returns/:id/cancel

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
}

const httpError = (res: any, err: any) => res.status(err.status || 500).json({ error: err.message });
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
type Db = { query: (s: string, p?: any[]) => Promise<any> };

async function loadReturn(db: Db, id: number) {
  const { rows: [r] } = await db.query(
    `SELECT r.*, c.client_name, i.invoice_number, cn.credit_note_number FROM customer_returns r LEFT JOIN clients c ON c.id = r.client_id
       LEFT JOIN invoices i ON i.id = r.invoice_id LEFT JOIN credit_notes cn ON cn.id = r.credit_note_id WHERE r.id = $1`, [id]);
  if (!r) return null;
  const { rows: lines } = await db.query(`SELECT * FROM customer_return_lines WHERE return_id = $1 ORDER BY id`, [id]);
  return { ...r, lines };
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
  await client.query(
    `INSERT INTO user_activity_logs (user_email, action, entity_type, entity_id, details, status) VALUES ((SELECT email FROM users WHERE email = $1), 'CLOSE_RETURN', 'Return', $2, $3, 'SUCCESS')`,
    [who, r.number, JSON.stringify({ restocked, creditNote: creditNote?.number ?? null, by: who })]);
  return { number: r.number as string, restocked, creditNote };
}

export function registerReturnsRoutes(app: Express): void {
  app.get('/api/returns', async (_req, res) => {
    try {
      const { rows } = await query(`SELECT r.*, c.client_name, i.invoice_number, cn.credit_note_number,
          (SELECT COUNT(*)::int FROM customer_return_lines l WHERE l.return_id = r.id) AS lines
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

  app.post('/api/returns/:id/cancel', async (req, res) => {
    try {
      const { rowCount } = await query(`UPDATE customer_returns SET status = 'CANCELLED' WHERE id = $1 AND status IN ('OPEN', 'RECEIVED')`, [parseInt(req.params.id)]);
      if (!rowCount) return res.status(409).json({ error: 'Only an open or received return can be cancelled.' });
      res.json({ ok: true });
    } catch (err) { httpError(res, err); }
  });
}
