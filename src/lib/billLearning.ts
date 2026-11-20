// Learning each supplier's invoices from the bills made from them.
//
// When a bill is saved from a read invoice (a scanned bill, or Scan Receipt),
// what was read is kept beside what was saved: an example. A supplier's
// profile is worked out from its last 20 examples, newest first:
//   - each of its codes (or, without a code, each description) -> the stock
//     item and the description saved for it, and that line's account and VAT
//     rate;
//   - the shape of its invoice numbers ("SO-" + 6 digits), to find the number
//     in the text or put back a prefix the reader lost;
//   - the days from invoice date to due date.
// The next invoice read from that supplier is filled in from the profile
// (applyProfile). Nothing leaves the server; the profile can be seen and
// cleared from the vendor's page.
//
//   POST /api/bills/:id/learn                        {ocr}: keep this bill as an example
//   GET  /api/bill-read-profiles/:supplierId          what was learned
//   POST /api/bills/read-profiles/:supplierId/clear   forget it

import type { Express, Response } from 'express';
import { query, exec } from './db';
import type { BillOcr } from './billOcr';

export async function ensureBillLearningSchema(): Promise<void> {
  await exec(`CREATE TABLE IF NOT EXISTS bill_read_examples (
    id SERIAL PRIMARY KEY,
    supplier_id TEXT NOT NULL,
    bill_id INTEGER UNIQUE,
    ocr JSONB NOT NULL,
    saved JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await exec(`CREATE INDEX IF NOT EXISTS bill_read_examples_supplier ON bill_read_examples (supplier_id, created_at DESC)`);
}

// ---------------------------------------------------------------------------
// The learning, without a database (unit-tested).

export interface SavedLine { description: string; partNumber: string | null; quantity: number; unitPrice: number; accountId: number | null; taxRateId: number | null }
export interface SavedBill { supplierInvoiceNumber: string | null; billDate: string | null; dueDate: string | null; lines: SavedLine[] }
export interface Example { ocr: BillOcr; saved: SavedBill }
type ReadLine = BillOcr['lineItems'][number];

export interface LearnedLine { item: string | null; description: string; accountId: number | null; taxRateId: number | null; seen: number; label: string }
export interface Profile {
  bills: number;
  lines: Record<string, LearnedLine>;
  invoiceShape: { prefix: string; digits: number } | null;
  dueDays: number | null;
  accountId: number | null;
  taxRateId: number | null;
}

const norm = (s: unknown) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
/** What identifies a line across invoices: the supplier's code, else the start of its description. */
export const lineKey = (l: { partNumber?: string | null; description?: string | null }) =>
  norm(l.partNumber).length >= 3 ? `C:${norm(l.partNumber)}` : `D:${norm(l.description).slice(0, 32)}`;
const words = (s: string) => new Set(String(s).toUpperCase().split(/[^A-Z0-9]+/).filter(w => w.length >= 3));
const overlap = (a: string, b: string) => { const A = words(a), B = words(b); if (!A.size || !B.size) return 0; let n = 0; A.forEach(w => { if (B.has(w)) n++; }); return n / Math.min(A.size, B.size); };

/** Each read line with the saved line it became: by position when the counts match, else by quantity and price, else by words. */
export function alignLines(read: ReadLine[], saved: SavedLine[]): Array<[ReadLine, SavedLine]> {
  if (read.length === saved.length) return read.map((r, i) => [r, saved[i]]);
  const used = new Set<number>();
  const out: Array<[ReadLine, SavedLine]> = [];
  for (const r of read) {
    let j = saved.findIndex((s, k) => !used.has(k) && s.quantity === r.quantity && Math.abs(s.unitPrice - r.unitPrice) < 0.01);
    if (j < 0) {
      let best = 0.5;
      saved.forEach((s, k) => { const o = overlap(r.description, s.description); if (!used.has(k) && o >= best) { best = o; j = k; } });
    }
    if (j >= 0) { used.add(j); out.push([r, saved[j]]); }
  }
  return out;
}

/** The shape of an invoice number: what comes before its digits, and how many digits ("SO-153667" -> SO- and 6). */
export function invoiceShape(n: string | null): { prefix: string; digits: number } | null {
  const m = /^([A-Za-z]*[\s\-\/]?)(\d{3,12})$/.exec(String(n ?? '').trim());
  return m ? { prefix: m[1].toUpperCase(), digits: m[2].length } : null;
}

const mostCommon = <T>(xs: T[]): T | null => {
  const n = new Map<T, number>();
  xs.forEach(x => n.set(x, (n.get(x) ?? 0) + 1));
  let best: T | null = null, top = 0;
  n.forEach((c, x) => { if (c > top) { best = x; top = c; } });
  return best;
};

/** A supplier's profile from its examples, newest first: the newest example wins where they differ. */
export function learnProfile(examples: Example[]): Profile {
  const lines: Record<string, LearnedLine> = {};
  for (const ex of examples) {
    for (const [r, s] of alignLines(ex.ocr.lineItems ?? [], ex.saved.lines)) {
      const k = lineKey(r);
      if (lines[k]) { lines[k].seen++; continue; }
      lines[k] = { item: s.partNumber || null, description: s.description, accountId: s.accountId, taxRateId: s.taxRateId, seen: 1, label: r.partNumber || r.description.slice(0, 40) };
    }
  }
  const shape = examples.map(e => invoiceShape(e.saved.supplierInvoiceNumber)).find(Boolean) ?? null;
  const days = examples.map(e => {
    const a = Date.parse(e.saved.billDate ?? ''), b = Date.parse(e.saved.dueDate ?? '');
    return Number.isFinite(a) && Number.isFinite(b) && b >= a ? Math.round((b - a) / 86_400_000) : null;
  }).find(d => d !== null) ?? null;
  const newest = examples[0]?.saved.lines ?? [];
  return {
    bills: examples.length, lines, invoiceShape: shape, dueDays: days,
    accountId: mostCommon(newest.map(l => l.accountId).filter((x): x is number => x != null)),
    taxRateId: mostCommon(newest.map(l => l.taxRateId).filter((x): x is number => x != null)),
  };
}

export interface Applied {
  learnedFrom: number;
  invoiceNumber: string | null;
  dueDays: number | null;
  lines: Array<{ item: string | null; description: string | null; accountId: number | null; taxRateId: number | null; learned: boolean }>;
}

/** What a profile adds to a newly read invoice from the same supplier. */
export function applyProfile(o: BillOcr, p: Profile | null): Applied | null {
  if (!p || !p.bills) return null;
  let invoiceNumber = o.invoiceNumber;
  const shape = p.invoiceShape;
  if (shape) {
    const fits = (v: string | null) => !!v && new RegExp(`^${shape.prefix.replace(/[^A-Z0-9]/g, '').split('').join('[\\s\\-\\/]?')}[\\s\\-\\/]?\\d{${shape.digits}}$`, 'i').test(v.trim());
    if (!fits(invoiceNumber)) {
      // In the text, with the prefix as it was printed (spaces or dashes misread around it)...
      const letters = shape.prefix.replace(/[^A-Z0-9]/g, '');
      // Letters a reader confuses with digits match either ("S0" for "SO").
      const LIKE: Record<string, string> = { O: '[O0]', I: '[I1L]', L: '[L1I]', S: '[S5]', B: '[B8]', Z: '[Z2]', G: '[G6]' };
      const inText = letters ? new RegExp(`\\b${letters.split('').map(ch => LIKE[ch] ?? ch).join('\\s?')}[\\s\\-\\/]{0,2}(\\d{${shape.digits}})\\b`, 'i').exec(o.text ?? '') : null;
      // ...or the digits the reader did find, with the prefix put back.
      const digits = new RegExp(`(?:^|\\D)(\\d{${shape.digits}})(?:\\D|$)`).exec(invoiceNumber ?? '')?.[1];
      if (inText) invoiceNumber = `${shape.prefix}${inText[1]}`;
      else if (digits) invoiceNumber = `${shape.prefix}${digits}`;
    }
  }
  return {
    learnedFrom: p.bills,
    invoiceNumber,
    dueDays: p.dueDays,
    lines: (o.lineItems ?? []).map(l => {
      const hit = p.lines[lineKey(l)];
      return hit
        ? { item: hit.item, description: hit.description, accountId: hit.accountId, taxRateId: hit.taxRateId, learned: true }
        : { item: null, description: null, accountId: p.accountId, taxRateId: p.taxRateId, learned: false };
    }),
  };
}

// ---------------------------------------------------------------------------
// Database work.

type Db = { query: (s: string, p?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export async function profileFor(db: Db, supplierId: string | null | undefined): Promise<Profile | null> {
  if (!supplierId) return null;
  const { rows } = await db.query(`SELECT ocr, saved FROM bill_read_examples WHERE supplier_id = $1 ORDER BY created_at DESC, id DESC LIMIT 20`, [String(supplierId)]);
  return rows.length ? learnProfile(rows.map((r: any) => ({ ocr: r.ocr, saved: r.saved }))) : null;
}

/** Keeps a saved bill and what was read for it as an example of its supplier's invoices. */
export async function recordExample(db: Db, billId: number, ocr: BillOcr) {
  const { rows: [b] } = await db.query(`SELECT id, supplier_id, supplier_invoice_number, bill_date, due_date FROM bills WHERE id = $1`, [billId]);
  if (!b) throw Object.assign(new Error('That bill no longer exists.'), { status: 404 });
  if (!b.supplier_id) return { learned: false, reason: 'The bill has no supplier.' };
  const { rows: items } = await db.query(`SELECT part_number, description, quantity, unit_price, account_id, tax_rate_id FROM bill_items WHERE bill_id = $1 ORDER BY id`, [billId]);
  const iso = (d: any) => (d ? new Date(d).toISOString().slice(0, 10) : null);
  const saved: SavedBill = {
    supplierInvoiceNumber: b.supplier_invoice_number ?? null, billDate: iso(b.bill_date), dueDate: iso(b.due_date),
    lines: items.map((i: any) => ({ description: i.description, partNumber: i.part_number || null, quantity: Number(i.quantity) || 0, unitPrice: Number(i.unit_price) || 0, accountId: i.account_id ?? null, taxRateId: i.tax_rate_id ?? null })),
  };
  // The read text is kept short: the profile only needs the fields and the lines.
  const keep = { ...ocr, text: String(ocr?.text ?? '').slice(0, 4000) };
  await db.query(
    `INSERT INTO bill_read_examples (supplier_id, bill_id, ocr, saved) VALUES ($1, $2, $3, $4)
     ON CONFLICT (bill_id) DO UPDATE SET supplier_id = EXCLUDED.supplier_id, ocr = EXCLUDED.ocr, saved = EXCLUDED.saved, created_at = now()`,
    [String(b.supplier_id), billId, JSON.stringify(keep), JSON.stringify(saved)]);
  return { learned: true };
}

const send = (res: Response, e: any, what: string) => {
  if (e?.status && e.status < 500) return res.status(e.status).json({ error: e.message });
  console.error(`[bill-learning] ${what} failed:`, e?.message);
  res.status(500).json({ error: `Could not ${what}. Please try again.` });
};

export function registerBillLearningRoutes(app: Express): void {
  app.post('/api/bills/:id/learn', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const ocr = req.body?.ocr;
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Not a valid bill.' });
      if (!ocr || typeof ocr !== 'object' || !Array.isArray(ocr.lineItems)) return res.status(400).json({ error: 'Send what was read (ocr).' });
      if (JSON.stringify(ocr).length > 200_000) return res.status(413).json({ error: 'That read is too large to keep.' });
      res.json(await recordExample({ query: (s, p) => query(s, p) }, id, ocr));
    } catch (e) { send(res, e, 'learn from the bill'); }
  });

  app.get('/api/bill-read-profiles/:supplierId', async (req, res) => {
    try {
      const sid = String(req.params.supplierId);
      const { rows } = await query(
        `SELECT e.ocr, e.saved, e.created_at, b.bill_number FROM bill_read_examples e LEFT JOIN bills b ON b.id = e.bill_id
          WHERE e.supplier_id = $1 ORDER BY e.created_at DESC, e.id DESC LIMIT 20`, [sid]);
      if (!rows.length) return res.json({ bills: 0, examples: [], lines: [], invoiceShape: null, dueDays: null });
      const p = learnProfile(rows.map((r: any) => ({ ocr: r.ocr, saved: r.saved })));
      res.json({
        bills: p.bills,
        examples: rows.map((r: any) => ({ billNumber: r.bill_number, at: r.created_at })),
        lines: Object.values(p.lines).sort((a, b) => b.seen - a.seen).map(l => ({ label: l.label, item: l.item, description: l.description, seen: l.seen })),
        invoiceShape: p.invoiceShape, dueDays: p.dueDays,
      });
    } catch (e) { send(res, e, 'load what was learned'); }
  });

  app.post('/api/bills/read-profiles/:supplierId/clear', async (req, res) => {
    try {
      const r = await query(`DELETE FROM bill_read_examples WHERE supplier_id = $1`, [String(req.params.supplierId)]);
      res.json({ cleared: r.rowCount ?? 0 });
    } catch (e) { send(res, e, 'forget what was learned'); }
  });
}
