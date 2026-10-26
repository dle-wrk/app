// Recurring invoices: a template (customer, lines, how often) that becomes a
// DRAFT invoice on each due date, to check and Finalize & Send as any other.
// Drafts aren't in the books, so a wrong one costs nothing until sent. The
// check runs daily on the deployed server (and on Run now); a date missed
// while the server was down is caught up, at most 12 at a time.
//
//   GET    /api/recurring-invoices
//   POST   /api/recurring-invoices                {name, clientId, currency?, frequency, every?, nextDate, endDate?, termsDays?, notes?, lines}
//   PUT    /api/recurring-invoices/:id            the same fields, and active
//   DELETE /api/recurring-invoices/:id
//   POST   /api/recurring-invoices/run            create the invoices that are due now

import type { Express } from 'express';
import { pool, query, exec } from './db';
import { computeDocumentTotals, computeLineTotals, nextDocNumber } from './bookkeeping-db';
import { resolveTaxPercent } from './bookkeeping-routes';

export type Frequency = 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY';
export const FREQUENCIES: Frequency[] = ['WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'];
export interface TemplateLine { partNumber?: string | null; description: string; quantity: number; unitPrice: number; taxRateId?: number | null; taxInclusive?: boolean }

export async function ensureRecurringInvoicesSchema(run: (sql: string) => Promise<void> = exec): Promise<void> {
  await run(`CREATE TABLE IF NOT EXISTS recurring_invoices (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    currency TEXT NOT NULL DEFAULT 'ZAR',
    frequency TEXT NOT NULL CHECK (frequency IN ('WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY')),
    every INTEGER NOT NULL DEFAULT 1 CHECK (every BETWEEN 1 AND 24),
    next_date DATE NOT NULL,
    end_date DATE,
    terms_days INTEGER NOT NULL DEFAULT 30,
    notes TEXT,
    lines JSONB NOT NULL DEFAULT '[]',
    active BOOLEAN NOT NULL DEFAULT true,
    last_run_at TIMESTAMPTZ, last_invoice_number TEXT, invoices_made INTEGER NOT NULL DEFAULT 0,
    created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** The date after `from`: weeks, or months kept on the same day (31 Jan + 1 month is 28/29 Feb). */
export function advance(from: string, frequency: Frequency, every = 1): string {
  const [y, m, d] = from.split('-').map(Number);
  if (frequency === 'WEEKLY') return iso(new Date(Date.UTC(y, m - 1, d + 7 * every)));
  const months = (frequency === 'MONTHLY' ? 1 : frequency === 'QUARTERLY' ? 3 : 12) * every;
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return iso(new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d, last))));
}

/** The invoice dates due by `today` from `next`, at most `max`, stopping after `end`. */
export function dueDates(next: string, frequency: Frequency, every: number, today: string, end: string | null, max = 12): { dates: string[]; next: string } {
  const dates: string[] = []; let d = next;
  while (d <= today && (!end || d <= end) && dates.length < max) { dates.push(d); d = advance(d, frequency, every); }
  return { dates, next: d };
}

type Db = { query: (s: string, p?: any[]) => Promise<any> };
const httpError = (res: any, err: any) => res.status(err.status || 500).json({ error: err.message });

/** Creates the DRAFT invoices due by today (all templates, or one), in the caller's transaction. */
export async function createDueRecurring(client: Db, today = iso(new Date()), onlyId?: number): Promise<Array<{ template: string; invoiceNumber: string; date: string }>> {
  const made: Array<{ template: string; invoiceNumber: string; date: string }> = [];
  {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('recurring-invoices'))`); // one run at a time, on any machine
    const { rows: due } = await client.query(
      `SELECT *, to_char(next_date, 'YYYY-MM-DD') AS next_s, to_char(end_date, 'YYYY-MM-DD') AS end_s FROM recurring_invoices WHERE active AND next_date <= $1 AND (end_date IS NULL OR next_date <= end_date)${onlyId ? ' AND id = $2' : ''} ORDER BY id FOR UPDATE`,
      onlyId ? [today, onlyId] : [today]);
    for (const t of due) {
      const { dates, next } = dueDates(t.next_s, t.frequency, t.every, today, t.end_s ?? null);
      for (const date of dates) {
        const computed = await Promise.all((t.lines as TemplateLine[]).map(async (l) => {
          const taxPct = await resolveTaxPercent(l.taxRateId ?? null);
          return { l, ...computeLineTotals({ quantity: Number(l.quantity), unitPrice: Number(l.unitPrice), taxRatePercent: taxPct, taxInclusive: !!l.taxInclusive } as any) };
        }));
        const { subtotal, taxTotal, total } = computeDocumentTotals(computed, 0);
        const number = await nextDocNumber(client as any, 'INV', 'invoice_seq');
        const dueDate = iso(new Date(new Date(`${date}T00:00:00Z`).getTime() + Number(t.terms_days) * 86_400_000));
        const { rows: [inv] } = await client.query(
          `INSERT INTO invoices (invoice_number, client_id, invoice_date, due_date, status, currency, subtotal, tax_total, discount_total, total, balance_due, notes)
           VALUES ($1, $2, $3, $4, 'DRAFT', $5, $6, $7, 0, $8, $8, $9) RETURNING id`,
          [number, t.client_id, date, dueDate, t.currency, subtotal, taxTotal, total, [t.notes, `From recurring invoice "${t.name}".`].filter(Boolean).join('\n')]);
        for (const c of computed) {
          await client.query(
            `INSERT INTO invoice_items (invoice_id, part_number, description, quantity, unit_price, tax_rate_id, tax_amount, line_total, deduct_stock, tax_inclusive)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9)`,
            [inv.id, c.l.partNumber || null, c.l.description, c.l.quantity, c.l.unitPrice, c.l.taxRateId || null, c.taxAmount, c.lineTotal, !!c.l.taxInclusive]);
        }
        made.push({ template: t.name, invoiceNumber: number, date });
      }
      await client.query(
        `UPDATE recurring_invoices SET next_date = $2, last_run_at = now(), last_invoice_number = COALESCE($3, last_invoice_number), invoices_made = invoices_made + $4,
           active = CASE WHEN end_date IS NOT NULL AND $2::date > end_date THEN false ELSE active END WHERE id = $1`,
        [t.id, next, made.filter((m) => m.template === t.name).at(-1)?.invoiceNumber ?? null, dates.length]);
    }
  }
  return made;
}

/** The daily run (and Run now): createDueRecurring in its own transaction. */
export async function runDueRecurring(today = iso(new Date()), onlyId?: number) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const made = await createDueRecurring(client, today, onlyId);
    await client.query('COMMIT');
    return made;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

function parseTemplate(b: any): { ok: true; v: any } | { ok: false; error: string } {
  const name = String(b?.name ?? '').trim();
  if (!name) return { ok: false, error: 'Give it a name, such as "Monitoring - Lumax".' };
  if (!b.clientId) return { ok: false, error: 'Choose the customer.' };
  if (!FREQUENCIES.includes(b.frequency)) return { ok: false, error: 'How often: weekly, monthly, quarterly or yearly.' };
  const every = Math.floor(Number(b.every ?? 1));
  if (!(every >= 1 && every <= 24)) return { ok: false, error: 'Every 1 to 24 periods.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.nextDate ?? ''))) return { ok: false, error: 'Give the date of the next invoice.' };
  if (b.endDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(b.endDate))) return { ok: false, error: 'The end date must be a date.' };
  const lines = (Array.isArray(b.lines) ? b.lines : []).map((l: any) => ({
    partNumber: String(l.partNumber ?? '').trim() || null, description: String(l.description ?? '').trim(), quantity: Number(l.quantity), unitPrice: Number(l.unitPrice),
    taxRateId: l.taxRateId ? Number(l.taxRateId) : null, taxInclusive: !!l.taxInclusive,
  })).filter((l: any) => (l.description || l.partNumber) && l.quantity > 0);
  if (!lines.length) return { ok: false, error: 'Add at least one line.' };
  return { ok: true, v: { name, clientId: Number(b.clientId), currency: String(b.currency || 'ZAR'), frequency: b.frequency, every, nextDate: b.nextDate, endDate: b.endDate || null, termsDays: Math.max(0, Math.floor(Number(b.termsDays ?? 30))), notes: String(b.notes ?? '').trim() || null, lines } };
}

export function registerRecurringInvoiceRoutes(app: Express): void {
  app.get('/api/recurring-invoices', async (_req, res) => {
    try {
      // Dates as text (a DATE read as a JS Date is local midnight, a day early in UTC).
      const { rows } = await query(`SELECT r.*, to_char(r.next_date, 'YYYY-MM-DD') AS next_date, to_char(r.end_date, 'YYYY-MM-DD') AS end_date, c.client_name
        FROM recurring_invoices r LEFT JOIN clients c ON c.id = r.client_id ORDER BY r.active DESC, r.next_date, r.id`);
      res.json(rows);
    } catch (err) { httpError(res, err); }
  });

  app.post('/api/recurring-invoices/run', async (_req, res) => {
    try { res.json({ made: await runDueRecurring() }); } catch (err) { httpError(res, err); }
  });

  app.post('/api/recurring-invoices', async (req: any, res) => {
    const p = parseTemplate(req.body);
    if (!p.ok) return res.status(400).json({ error: p.error });
    const v = p.v;
    try {
      const { rows } = await query(
        `INSERT INTO recurring_invoices (name, client_id, currency, frequency, every, next_date, end_date, terms_days, notes, lines, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [v.name, v.clientId, v.currency, v.frequency, v.every, v.nextDate, v.endDate, v.termsDays, v.notes, JSON.stringify(v.lines), req.user?.email ?? null]);
      res.status(201).json(rows[0]);
    } catch (err) { httpError(res, err); }
  });

  app.put('/api/recurring-invoices/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    try {
      if (req.body && Object.keys(req.body).length === 1 && 'active' in req.body) {
        const { rows } = await query(`UPDATE recurring_invoices SET active = $2 WHERE id = $1 RETURNING *`, [id, !!req.body.active]);
        if (!rows.length) return res.status(404).json({ error: 'Not found.' });
        return res.json(rows[0]);
      }
      const p = parseTemplate(req.body);
      if (!p.ok) return res.status(400).json({ error: p.error });
      const v = p.v;
      const { rows } = await query(
        `UPDATE recurring_invoices SET name=$2, client_id=$3, currency=$4, frequency=$5, every=$6, next_date=$7, end_date=$8, terms_days=$9, notes=$10, lines=$11, active=COALESCE($12, active) WHERE id=$1 RETURNING *`,
        [id, v.name, v.clientId, v.currency, v.frequency, v.every, v.nextDate, v.endDate, v.termsDays, v.notes, JSON.stringify(v.lines), req.body.active === undefined ? null : !!req.body.active]);
      if (!rows.length) return res.status(404).json({ error: 'Not found.' });
      res.json(rows[0]);
    } catch (err) { httpError(res, err); }
  });

  app.delete('/api/recurring-invoices/:id', async (req, res) => {
    try {
      const { rowCount } = await query(`DELETE FROM recurring_invoices WHERE id = $1`, [parseInt(req.params.id)]);
      if (!rowCount) return res.status(404).json({ error: 'Not found.' });
      res.json({ ok: true });
    } catch (err) { httpError(res, err); }
  });
}

