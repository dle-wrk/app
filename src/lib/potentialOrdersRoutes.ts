// Potential Orders and client history (the rules: ./potentialOrders).
// Changes need orders.update (admins and managers): the 'potential-orders'
// and 'client-events' areas in ./writeAccess; anyone signed in can read.
//
//   GET  /api/potential-orders                       all, newest first
//   POST /api/potential-orders                       a new one from scratch
//   PUT  /api/potential-orders/:id                   details and lines, while open
//   POST /api/potential-orders/from-invoice/:id      take an invoice out of the books into one
//   POST /api/potential-orders/from-order/:id        park a sales order or quote as one
//   POST /api/potential-orders/:id/won   {as}        becomes a quotation, sales order or draft invoice
//   POST /api/potential-orders/:id/lost  {reason}
//   GET  /api/clients/:id/history                    documents, moves and notes, newest first
//   POST /api/clients/:id/events  {kind, body, followUpDate}
//   PUT  /api/client-events/:id   {followUpDone}
//   GET  /api/follow-ups?until=YYYY-MM-DD           notes to follow up and decisions due

import type { Express } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { exec, pool, query, queryOne } from './db';
import { computeDocumentTotals, computeLineTotals, nextDocNumber, reverseJournalEntry, rewriteReservations } from './bookkeeping-db';
import { resolveTaxPercent, returnInvoiceStock } from './bookkeeping-routes';
import { LIKELIHOODS, NOTE_KINDS, WIN_TARGETS, sortHistory, type HistoryEntry, type PotentialLine } from './potentialOrders';

export async function ensurePotentialOrdersSchema(run: (sql: string) => Promise<void> = exec): Promise<void> {
  await run(`CREATE SEQUENCE IF NOT EXISTS potential_order_seq`);
  await run(`CREATE TABLE IF NOT EXISTS potential_orders (
    id SERIAL PRIMARY KEY,
    number TEXT NOT NULL UNIQUE,
    client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    currency TEXT NOT NULL DEFAULT 'ZAR',
    lines JSONB NOT NULL DEFAULT '[]'::jsonb,
    subtotal NUMERIC(14,2) NOT NULL DEFAULT 0,
    tax_total NUMERIC(14,2) NOT NULL DEFAULT 0,
    total NUMERIC(14,2) NOT NULL DEFAULT 0,
    notes TEXT,
    expected_date DATE,
    likelihood_pct INTEGER CHECK (likelihood_pct BETWEEN 0 AND 100),
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'WON', 'LOST')),
    outcome_reason TEXT,
    outcome_at TIMESTAMPTZ,
    outcome_doc_type TEXT,
    outcome_doc_id INTEGER,
    outcome_doc_number TEXT,
    source_type TEXT NOT NULL DEFAULT 'new' CHECK (source_type IN ('new', 'invoice', 'sales_order', 'quotation')),
    source_id INTEGER,
    source_number TEXT,
    created_by TEXT,
    updated_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await run(`CREATE TABLE IF NOT EXISTS client_events (
    id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('note', 'call', 'meeting', 'email', 'system')),
    body TEXT NOT NULL,
    doc_type TEXT,
    doc_number TEXT,
    follow_up_date DATE,
    follow_up_done BOOLEAN NOT NULL DEFAULT FALSE,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await run(`CREATE INDEX IF NOT EXISTS client_events_client_idx ON client_events (client_id, created_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS client_events_follow_up_idx ON client_events (follow_up_date) WHERE follow_up_date IS NOT NULL AND follow_up_done = FALSE`);
}

const LineSchema = z.object({
  partNumber: z.string().trim().max(120).nullable().optional(),
  description: z.string().trim().min(1).max(500),
  quantity: z.number().positive().max(10_000_000),
  unitPrice: z.number().min(-1_000_000_000).max(1_000_000_000),
  taxRateId: z.number().int().nullable().optional(),
  taxInclusive: z.boolean().optional(),
}).refine((l) => l.unitPrice >= 0 || !String(l.partNumber ?? '').trim(), { message: "A negative line (a discount) can't have a part number." });
const DetailsSchema = z.object({
  expectedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  likelihoodPct: z.number().int().refine((v) => (LIKELIHOODS as readonly number[]).includes(v), 'Choose a likelihood.').nullable().optional(),
  reason: z.string().trim().max(500).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});
const NewSchema = DetailsSchema.extend({
  clientId: z.number().int(),
  currency: z.string().trim().length(3).default('ZAR'),
  lines: z.array(LineSchema).min(1).max(500),
});
const EditSchema = DetailsSchema.extend({
  clientId: z.number().int().optional(),
  currency: z.string().trim().length(3).optional(),
  lines: z.array(LineSchema).min(1).max(500).optional(),
});

const who = (req: any) => req.user?.email || 'unknown';
const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

async function totalsFor(lines: PotentialLine[]) {
  const computed = await Promise.all(lines.map(async (l) => ({ ...l, ...computeLineTotals({ quantity: l.quantity, unitPrice: l.unitPrice, taxRatePercent: await resolveTaxPercent(l.taxRateId), taxInclusive: !!l.taxInclusive } as any) })));
  const t = computeDocumentTotals(computed);
  return { computed, subtotal: t.subtotal, taxTotal: t.taxTotal, total: t.total };
}

const cleanLines = (lines: z.infer<typeof LineSchema>[]): PotentialLine[] => lines.map((l) => ({
  partNumber: l.partNumber?.trim() || null, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice,
  taxRateId: l.taxRateId ?? null, taxInclusive: !!l.taxInclusive,
}));

async function logEvent(db: { query: (text: string, params?: any[]) => Promise<any> }, clientId: number | null, body: string, docType: string | null, docNumber: string | null, by: string) {
  if (!clientId) return;
  await db.query(`INSERT INTO client_events (client_id, kind, body, doc_type, doc_number, created_by) VALUES ($1, 'system', $2, $3, $4, $5)`, [clientId, body, docType, docNumber, by]);
}

async function insertPotential(db: PoolClient, p: {
  clientId: number | null; currency: string; lines: PotentialLine[]; notes: string | null; expectedDate?: string | null; likelihoodPct?: number | null; reason?: string | null;
  sourceType: 'new' | 'invoice' | 'sales_order' | 'quotation'; sourceId: number | null; sourceNumber: string | null; by: string;
}) {
  const t = await totalsFor(p.lines);
  const number = await nextDocNumber(db, 'POT', 'potential_order_seq');
  const { rows } = await db.query(
    `INSERT INTO potential_orders (number, client_id, currency, lines, subtotal, tax_total, total, notes, expected_date, likelihood_pct, reason, source_type, source_id, source_number, created_by, updated_by)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15) RETURNING *`,
    [number, p.clientId, p.currency, JSON.stringify(p.lines), t.subtotal, t.taxTotal, t.total, p.notes, p.expectedDate ?? null, p.likelihoodPct ?? null, p.reason ?? null, p.sourceType, p.sourceId, p.sourceNumber, p.by]);
  return rows[0];
}

const mapPotential = (r: any) => ({
  id: r.id, number: r.number, clientId: r.client_id, clientName: r.client_name ?? null, currency: r.currency, lines: r.lines ?? [],
  subtotal: Number(r.subtotal), taxTotal: Number(r.tax_total), total: Number(r.total), notes: r.notes,
  expectedDate: r.expected_date ? new Date(r.expected_date).toISOString().slice(0, 10) : null,
  likelihoodPct: r.likelihood_pct, reason: r.reason, status: r.status, outcomeReason: r.outcome_reason, outcomeAt: r.outcome_at,
  outcomeDocType: r.outcome_doc_type, outcomeDocId: r.outcome_doc_id, outcomeDocNumber: r.outcome_doc_number,
  sourceType: r.source_type, sourceId: r.source_id, sourceNumber: r.source_number,
  createdBy: r.created_by, updatedBy: r.updated_by, createdAt: r.created_at, updatedAt: r.updated_at,
});

/** Runs fn in a transaction, answering with its result or its error. */
async function inTx(res: any, fn: (db: PoolClient) => Promise<any>, okStatus = 200) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const out = await fn(db);
    await db.query('COMMIT');
    res.status(okStatus).json(out);
  } catch (err: any) {
    await db.query('ROLLBACK').catch(() => {});
    res.status(err?.status || 500).json({ error: err?.message || 'Failed' });
  } finally {
    db.release();
  }
}

export function registerPotentialOrdersRoutes(app: Express): void {
  app.get('/api/potential-orders', async (_req, res) => {
    try {
      const { rows } = await query(`SELECT p.*, c.client_name FROM potential_orders p LEFT JOIN clients c ON c.id = p.client_id ORDER BY p.id DESC`);
      res.json(rows.map(mapPotential));
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/potential-orders', (req: any, res) => {
    const parsed = NewSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Check the details.' });
    const b = parsed.data;
    return inTx(res, async (db) => {
      const row = await insertPotential(db, { ...b, notes: b.notes ?? null, lines: cleanLines(b.lines), sourceType: 'new', sourceId: null, sourceNumber: null, by: who(req) });
      await logEvent(db, b.clientId, `Potential order ${row.number} created (${row.currency} ${Number(row.total).toFixed(2)}).`, 'potential', row.number, who(req));
      return mapPotential(row);
    }, 201);
  });

  app.put('/api/potential-orders/:id', (req: any, res) => {
    const id = Number(req.params.id);
    const parsed = EditSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Check the details.' });
    const b = parsed.data;
    return inTx(res, async (db) => {
      const { rows } = await db.query(`SELECT * FROM potential_orders WHERE id = $1 FOR UPDATE`, [id]);
      const cur = rows[0];
      if (!cur) throw httpError(404, 'Potential order not found');
      if (cur.status !== 'OPEN') throw httpError(400, `It is already ${cur.status === 'WON' ? 'won' : 'lost'}.`);
      const lines = b.lines ? cleanLines(b.lines) : cur.lines;
      const t = await totalsFor(lines);
      const { rows: up } = await db.query(
        `UPDATE potential_orders SET client_id = $1, currency = $2, lines = $3::jsonb, subtotal = $4, tax_total = $5, total = $6, notes = $7,
           expected_date = $8, likelihood_pct = $9, reason = $10, updated_by = $11, updated_at = now() WHERE id = $12 RETURNING *`,
        [b.clientId ?? cur.client_id, b.currency ?? cur.currency, JSON.stringify(lines), t.subtotal, t.taxTotal, t.total,
          b.notes !== undefined ? b.notes : cur.notes, b.expectedDate !== undefined ? b.expectedDate : cur.expected_date,
          b.likelihoodPct !== undefined ? b.likelihoodPct : cur.likelihood_pct, b.reason !== undefined ? b.reason : cur.reason, who(req), id]);
      return mapPotential(up[0]);
    });
  });

  // An invoice out of the books: its journal entry reversed, stock it took returned, the invoice voided.
  app.post('/api/potential-orders/from-invoice/:id', (req: any, res) => {
    const id = Number(req.params.id);
    const parsed = DetailsSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Check the details.' });
    return inTx(res, async (db) => {
      const { rows } = await db.query(`SELECT * FROM invoices WHERE id = $1 FOR UPDATE`, [id]);
      const inv = rows[0];
      if (!inv) throw httpError(404, 'Invoice not found');
      if (inv.status === 'VOID') throw httpError(400, 'That invoice is void.');
      if (inv.status === 'PAID' || Number(inv.amount_paid) > 0) throw httpError(400, 'It has payments against it: void or reallocate the payments first, or issue a credit note instead.');
      const { rows: credits } = await db.query(`SELECT credit_note_number FROM credit_notes WHERE invoice_id = $1 AND status <> 'VOID' AND status <> 'DRAFT'`, [id]);
      if (credits.length) throw httpError(400, `It has a credit note (${credits.map((c: any) => c.credit_note_number).join(', ')}): it can't be taken out of the books.`);
      const { rows: items } = await db.query(`SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY id`, [id]);
      const lines: PotentialLine[] = items.map((i: any) => ({
        partNumber: i.part_number || null, description: i.description || i.part_number || '', quantity: Number(i.quantity) || 1,
        unitPrice: Number(i.unit_price) || 0, taxRateId: i.tax_rate_id ?? null, taxInclusive: !!i.tax_inclusive,
      }));
      const pot = await insertPotential(db, {
        clientId: inv.client_id, currency: inv.currency || 'ZAR', lines, notes: inv.notes, ...parsed.data,
        sourceType: 'invoice', sourceId: inv.id, sourceNumber: inv.invoice_number, by: who(req),
      });
      if (inv.status === 'DRAFT') {
        // Never posted: nothing to reverse.
        await db.query(`UPDATE invoices SET status = 'VOID', balance_due = 0, notes = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [id, `${inv.notes ? `${inv.notes}\n` : ''}Moved to Potential Order ${pot.number}.`]);
      } else {
        if (inv.journal_entry_id) {
          await reverseJournalEntry(db, inv.journal_entry_id, { sourceType: 'REVERSAL', sourceId: id, memo: `Invoice ${inv.invoice_number} moved to Potential Order ${pot.number}` });
        }
        // What it booked out, from the stock ledger (a sent invoice can have been edited).
        await returnInvoiceStock(db, inv.invoice_number, `moved to Potential Order ${pot.number}`);
        await db.query(`UPDATE invoices SET status = 'VOID', balance_due = 0, notes = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [id, `${inv.notes ? `${inv.notes}\n` : ''}Moved to Potential Order ${pot.number}: taken out of the books.`]);
      }
      await logEvent(db, inv.client_id, `Invoice ${inv.invoice_number} moved to Potential Order ${pot.number}${inv.status === 'DRAFT' ? '' : ' and taken out of the books (journal reversed, stock returned)'}.`, 'potential', pot.number, who(req));
      return mapPotential(pot);
    }, 201);
  });

  // A sales order or quote parked: its reservations released, status POTENTIAL.
  app.post('/api/potential-orders/from-order/:id', (req: any, res) => {
    const id = Number(req.params.id);
    const parsed = DetailsSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Check the details.' });
    return inTx(res, async (db) => {
      const { rows } = await db.query(`SELECT * FROM client_orders WHERE id = $1 FOR UPDATE`, [id]);
      const o = rows[0];
      if (!o) throw httpError(404, 'Sales order not found');
      if (['FULFILLED', 'CANCELLED', 'POTENTIAL'].includes(o.status)) throw httpError(400, `It is ${String(o.status).toLowerCase()}: it can't become a potential order.`);
      for (const [table, label] of [['invoices', 'an invoice'], ['dispatch_notes', 'a delivery note']] as const) {
        const { rows: refs } = await db.query(`SELECT 1 FROM ${table} WHERE client_order_id = $1 AND COALESCE(status, '') <> 'VOID' LIMIT 1`, [id]);
        if (refs.length) throw httpError(400, `It already has ${label}: it can't be parked.`);
      }
      const { rows: items } = await db.query(`SELECT * FROM client_order_items WHERE client_order_id = $1 ORDER BY id`, [id]);
      const lines: PotentialLine[] = items.map((i: any) => ({
        partNumber: i.part_number || null, description: i.description || i.part_number || '', quantity: Number(i.quantity) || 1,
        unitPrice: Number(i.unit_price) || 0, taxRateId: i.tax_rate_id ?? null, taxInclusive: !!i.tax_inclusive,
      }));
      const isQuote = o.status === 'QUOTATION';
      const pot = await insertPotential(db, {
        clientId: o.client_id, currency: o.currency || 'ZAR', lines, notes: o.notes, ...parsed.data,
        sourceType: isQuote ? 'quotation' : 'sales_order', sourceId: o.id, sourceNumber: o.order_number, by: who(req),
      });
      await db.query(`DELETE FROM client_order_reservations WHERE client_order_id = $1`, [id]);
      await db.query(`UPDATE client_orders SET status = 'POTENTIAL' WHERE id = $1`, [id]);
      await logEvent(db, o.client_id, `${isQuote ? 'Quotation' : 'Sales order'} ${o.order_number} parked as Potential Order ${pot.number}${isQuote ? '' : ' (stock reservations released)'}.`, 'potential', pot.number, who(req));
      return mapPotential(pot);
    }, 201);
  });

  app.post('/api/potential-orders/:id/won', (req: any, res) => {
    const id = Number(req.params.id);
    const as = String(req.body?.as || '');
    if (!(WIN_TARGETS as readonly string[]).includes(as)) return res.status(400).json({ error: 'Say what it becomes: quotation, sales_order or invoice.' });
    return inTx(res, async (db) => {
      const { rows } = await db.query(`SELECT * FROM potential_orders WHERE id = $1 FOR UPDATE`, [id]);
      const p = rows[0];
      if (!p) throw httpError(404, 'Potential order not found');
      if (p.status !== 'OPEN') throw httpError(400, `It is already ${p.status === 'WON' ? 'won' : 'lost'}.`);
      const lines: PotentialLine[] = p.lines ?? [];
      const t = await totalsFor(lines);
      // The sales order or quote it was parked from, if it's still parked.
      const parked = (p.source_type === 'sales_order' || p.source_type === 'quotation') && p.source_id
        ? (await db.query(`SELECT * FROM client_orders WHERE id = $1 AND status = 'POTENTIAL' FOR UPDATE`, [p.source_id])).rows[0] : null;
      let docType = as, docId: number, docNumber: string;

      if (as === 'invoice') {
        docNumber = await nextDocNumber(db, 'INV', 'invoice_seq');
        const today = new Date().toISOString().slice(0, 10);
        const { rows: inv } = await db.query(
          `INSERT INTO invoices (invoice_number, client_id, client_order_id, invoice_date, due_date, status, currency, subtotal, tax_total, discount_total, total, balance_due, notes, terms, is_warranty_claim)
           VALUES ($1, $2, NULL, $3, NULL, 'DRAFT', $4, $5, $6, 0, $7, $7, $8, NULL, FALSE) RETURNING id`,
          [docNumber, p.client_id, today, p.currency, t.subtotal, t.taxTotal, t.total, `${p.notes ? `${p.notes}\n` : ''}From Potential Order ${p.number}.`]);
        docId = inv[0].id;
        for (const l of t.computed) {
          await db.query(
            `INSERT INTO invoice_items (invoice_id, part_number, description, quantity, unit_price, tax_rate_id, tax_amount, line_total, deduct_stock, tax_inclusive)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE, $9)`,
            [docId, l.partNumber, l.description, l.quantity, l.unitPrice, l.taxRateId, l.taxAmount, l.lineTotal, !!l.taxInclusive]);
        }
        if (parked) await db.query(`UPDATE client_orders SET status = 'CANCELLED' WHERE id = $1`, [parked.id]);
      } else {
        const isQuote = as === 'quotation';
        if (parked) {
          // Back to the same document; a quote becoming an order (or back) gets that series' number.
          const wasQuote = String(parked.order_number).startsWith('QUO-');
          docNumber = wasQuote === isQuote ? parked.order_number : await nextDocNumber(db, isQuote ? 'QUO' : 'SO', isQuote ? 'quotation_seq' : 'sales_order_seq');
          await db.query(`UPDATE client_orders SET status = $1, order_number = $2, currency = $3, subtotal = $4, tax = $5, total = $6, notes = $7 WHERE id = $8`,
            [isQuote ? 'QUOTATION' : 'DRAFT', docNumber, p.currency, t.subtotal, t.taxTotal, t.total, p.notes, parked.id]);
          await db.query(`DELETE FROM client_order_items WHERE client_order_id = $1`, [parked.id]);
          docId = parked.id;
        } else {
          docNumber = await nextDocNumber(db, isQuote ? 'QUO' : 'SO', isQuote ? 'quotation_seq' : 'sales_order_seq');
          const { rows: o } = await db.query(
            `INSERT INTO client_orders (client_id, order_number, order_date, status, currency, subtotal, tax, total, notes)
             VALUES ($1, $2, CURRENT_DATE, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [p.client_id, docNumber, isQuote ? 'QUOTATION' : 'DRAFT', p.currency, t.subtotal, t.taxTotal, t.total, `${p.notes ? `${p.notes}\n` : ''}From Potential Order ${p.number}.`]);
          docId = o[0].id;
        }
        for (const l of t.computed) {
          await db.query(
            `INSERT INTO client_order_items (client_order_id, part_number, description, quantity, unit_price, line_total, tax_rate_id, tax_amount, tax_inclusive)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [docId, l.partNumber, l.description, l.quantity, l.unitPrice, l.lineTotal, l.taxRateId, l.taxAmount, !!l.taxInclusive]);
        }
        if (!isQuote) await rewriteReservations(db, docId, lines.map((l) => ({ partNumber: l.partNumber, quantity: l.quantity })));
      }
      const { rows: up } = await db.query(
        `UPDATE potential_orders SET status = 'WON', outcome_at = now(), outcome_doc_type = $1, outcome_doc_id = $2, outcome_doc_number = $3, updated_by = $4, updated_at = now()
          WHERE id = $5 RETURNING *`, [docType, docId, docNumber, who(req), id]);
      const label = as === 'invoice' ? 'draft invoice' : as === 'quotation' ? 'quotation' : 'sales order';
      await logEvent(db, p.client_id, `Potential Order ${p.number} won: now ${label} ${docNumber}.`, as, docNumber, who(req));
      return mapPotential(up[0]);
    });
  });

  app.post('/api/potential-orders/:id/lost', (req: any, res) => {
    const id = Number(req.params.id);
    const reason = String(req.body?.reason ?? '').trim().slice(0, 500);
    if (!reason) return res.status(400).json({ error: 'Say why it was lost.' });
    return inTx(res, async (db) => {
      const { rows } = await db.query(`SELECT * FROM potential_orders WHERE id = $1 FOR UPDATE`, [id]);
      const p = rows[0];
      if (!p) throw httpError(404, 'Potential order not found');
      if (p.status !== 'OPEN') throw httpError(400, `It is already ${p.status === 'WON' ? 'won' : 'lost'}.`);
      if ((p.source_type === 'sales_order' || p.source_type === 'quotation') && p.source_id) {
        await db.query(`UPDATE client_orders SET status = 'CANCELLED' WHERE id = $1 AND status = 'POTENTIAL'`, [p.source_id]);
      }
      const { rows: up } = await db.query(`UPDATE potential_orders SET status = 'LOST', outcome_reason = $1, outcome_at = now(), updated_by = $2, updated_at = now() WHERE id = $3 RETURNING *`, [reason, who(req), id]);
      await logEvent(db, p.client_id, `Potential Order ${p.number} lost: ${reason}`, 'potential', p.number, who(req));
      return mapPotential(up[0]);
    });
  });

  app.get('/api/clients/:id/history', async (req, res) => {
    const id = Number(req.params.id);
    try {
      const day = (d: any) => (d ? new Date(d).toISOString() : '');
      const out: HistoryEntry[] = [];
      const base = { by: null, eventId: null, followUpDate: null, followUpDone: false } as const;
      const [orders, invoices, payments, credits, deliveries, pots, events] = await Promise.all([
        query<any>(`SELECT order_number, order_date, created_at, status, total, currency FROM client_orders WHERE client_id = $1`, [id]),
        query<any>(`SELECT invoice_number, invoice_date, created_at, status, total, currency, balance_due FROM invoices WHERE client_id = $1`, [id]),
        query<any>(`SELECT payment_number, payment_date, created_at, amount, method FROM payments_received WHERE client_id = $1`, [id]),
        query<any>(`SELECT credit_note_number, credit_date, created_at, status, total, currency, reason FROM credit_notes WHERE client_id = $1`, [id]),
        query<any>(`SELECT note_number, note_type, note_date, created_at, status FROM dispatch_notes WHERE client_id = $1`, [id]),
        query<any>(`SELECT number, created_at, status, total, currency, reason, likelihood_pct, expected_date FROM potential_orders WHERE client_id = $1`, [id]),
        query<any>(`SELECT * FROM client_events WHERE client_id = $1`, [id]),
      ]);
      for (const o of orders.rows) {
        const quote = o.status === 'QUOTATION' || String(o.order_number).startsWith('QUO-');
        out.push({ ...base, at: day(o.created_at || o.order_date), kind: quote ? 'quotation' : 'sales_order', title: `${quote ? 'Quotation' : 'Sales order'} ${o.order_number}`, detail: `Now ${String(o.status).toLowerCase().replace(/_/g, ' ')}`, docNumber: o.order_number, amount: Number(o.total), currency: o.currency });
      }
      for (const i of invoices.rows) {
        out.push({ ...base, at: day(i.created_at || i.invoice_date), kind: 'invoice', title: `Invoice ${i.invoice_number}`, detail: `Now ${String(i.status).toLowerCase()}${Number(i.balance_due) > 0 && i.status !== 'VOID' ? `, ${Number(i.balance_due).toFixed(2)} due` : ''}`, docNumber: i.invoice_number, amount: Number(i.total), currency: i.currency });
      }
      for (const p of payments.rows) out.push({ ...base, at: day(p.created_at || p.payment_date), kind: 'payment', title: `Payment ${p.payment_number}`, detail: p.method || null, docNumber: p.payment_number, amount: Number(p.amount), currency: null });
      for (const c of credits.rows) out.push({ ...base, at: day(c.created_at || c.credit_date), kind: 'credit_note', title: `Credit note ${c.credit_note_number}`, detail: [String(c.status).toLowerCase(), c.reason].filter(Boolean).join(': '), docNumber: c.credit_note_number, amount: Number(c.total), currency: c.currency });
      for (const d of deliveries.rows) out.push({ ...base, at: day(d.created_at || d.note_date), kind: 'delivery', title: `${d.note_type === 'COLLECTION' ? 'Collection' : 'Delivery'} ${d.note_number}`, detail: `Now ${String(d.status).toLowerCase()}`, docNumber: d.note_number, amount: null, currency: null });
      for (const p of pots.rows) out.push({ ...base, at: day(p.created_at), kind: 'potential', title: `Potential Order ${p.number}`, detail: [String(p.status).toLowerCase(), p.likelihood_pct != null ? `${p.likelihood_pct}% likely` : null, p.reason].filter(Boolean).join(' · '), docNumber: p.number, amount: Number(p.total), currency: p.currency });
      for (const e of events.rows) {
        out.push({ at: day(e.created_at), kind: e.kind, title: e.kind === 'system' ? e.body : `${e.kind.charAt(0).toUpperCase()}${e.kind.slice(1)}`, detail: e.kind === 'system' ? null : e.body,
          docNumber: e.doc_number, amount: null, currency: null, by: e.created_by, eventId: e.id,
          followUpDate: e.follow_up_date ? new Date(e.follow_up_date).toISOString().slice(0, 10) : null, followUpDone: e.follow_up_done });
      }
      res.json(sortHistory(out));
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/clients/:id/events', async (req: any, res) => {
    const id = Number(req.params.id);
    const kind = String(req.body?.kind || 'note');
    const body = String(req.body?.body ?? '').trim();
    const follow = req.body?.followUpDate ? String(req.body.followUpDate) : null;
    if (!(NOTE_KINDS as readonly string[]).includes(kind)) return res.status(400).json({ error: 'Choose note, call, meeting or email.' });
    if (!body || body.length > 4000) return res.status(400).json({ error: 'Write the note (up to 4 000 characters).' });
    if (follow && !/^\d{4}-\d{2}-\d{2}$/.test(follow)) return res.status(400).json({ error: 'Follow-up date must be a date.' });
    try {
      const c = await queryOne(`SELECT id FROM clients WHERE id = $1`, [id]);
      if (!c) return res.status(404).json({ error: 'Client not found' });
      const row = await queryOne<any>(`INSERT INTO client_events (client_id, kind, body, follow_up_date, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *`, [id, kind, body, follow, who(req)]);
      res.status(201).json({ id: row.id });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/client-events/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (typeof req.body?.followUpDone !== 'boolean') return res.status(400).json({ error: 'Send followUpDone.' });
    try {
      const { rowCount } = await query(`UPDATE client_events SET follow_up_done = $1 WHERE id = $2`, [req.body.followUpDone, id]);
      if (!rowCount) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/follow-ups', async (req, res) => {
    const until = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.until || '')) ? String(req.query.until) : new Date().toISOString().slice(0, 10);
    try {
      const { rows: notes } = await query<any>(
        `SELECT e.id, e.client_id, c.client_name, e.kind, e.body, e.follow_up_date, e.created_by FROM client_events e JOIN clients c ON c.id = e.client_id
          WHERE e.follow_up_date IS NOT NULL AND e.follow_up_done = FALSE AND e.follow_up_date <= $1 ORDER BY e.follow_up_date, e.id`, [until]);
      const { rows: decisions } = await query<any>(
        `SELECT p.id, p.number, p.client_id, c.client_name, p.expected_date, p.total, p.currency, p.likelihood_pct, p.reason FROM potential_orders p
           LEFT JOIN clients c ON c.id = p.client_id WHERE p.status = 'OPEN' AND p.expected_date IS NOT NULL AND p.expected_date <= $1 ORDER BY p.expected_date`, [until]);
      res.json({
        until,
        notes: notes.map((n) => ({ id: n.id, clientId: n.client_id, clientName: n.client_name, kind: n.kind, body: n.body, followUpDate: new Date(n.follow_up_date).toISOString().slice(0, 10), by: n.created_by })),
        decisions: decisions.map((d) => ({ id: d.id, number: d.number, clientId: d.client_id, clientName: d.client_name, expectedDate: new Date(d.expected_date).toISOString().slice(0, 10), total: Number(d.total), currency: d.currency, likelihoodPct: d.likelihood_pct, reason: d.reason })),
      });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
}
