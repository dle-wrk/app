// Bills sent from the scanner, and filling in what existing bills miss.
//
// The phone (/scan "Scan a bill", or the scanner app) photographs a supplier
// invoice page by page and sends it; it lands in Purchases > Bills > From the
// scanner and is read straight away (./billOcr: supplier, VAT number, invoice
// number, dates, PO, lines, totals). Nothing becomes a bill on its own: on the
// website someone creates the bill from it (the form filled in, the photos
// attached), attaches it to a bill that exists, or discards it.
//
//   POST /api/bill-scans                    {pages: [data:image/…], note?, clientRef?, capturedAt?}  (anyone but viewers)
//   GET  /api/bill-scans?status=INBOX|USED|DISCARDED|ALL&mine=1   each with what was read and matched
//   GET  /api/bill-scans/:id                one, with its pages
//   POST /api/bills/inbox/:id/read          read it (again)
//   POST /api/bills/inbox/:id/discard       {reason?}
//   POST /api/bills/inbox/:id/attach        {billId}: its pages go on that bill
//   POST /api/bills/inbox/:id/add-supplier  {name, vatNumber?, address?, phone?, email?, website?}: a new supplier from it
//   POST /api/bills/inbox/:id/used          {billId, fillSupplier?}: a bill was made from it
//   POST /api/bills/:id/read-missing        read a bill's attached photos: what its supplier and it are missing
//   POST /api/bills/:id/fill-missing        {values: {key: value}}: fill those, only where still empty
//
// The /api/bills/... ones are bookkeeping (writeAccess "bills"); sending from
// the phone is open to anyone but viewers ("bill-scans": staff).

import type { Express, Response } from 'express';
import { pool, query, exec } from './db';
import { readBill, ocrAvailable, ocrWarnings, tidyVatNumber, type BillOcr } from './billOcr';
import { applyProfile, profileFor } from './billLearning';
import { roleCan, notAllowedMessage } from './permissions';
import { describeBank, invoiceBank, tidyInvoiceBank, type InvoiceBank } from './invoiceBank';
import { maskAccount } from './supplierBanking';

export async function ensureBillScansSchema(): Promise<void> {
  await exec(`CREATE TABLE IF NOT EXISTS bill_scans (
    id SERIAL PRIMARY KEY,
    client_ref TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'INBOX' CHECK (status IN ('INBOX', 'USED', 'DISCARDED')),
    pages JSONB NOT NULL,
    note TEXT,
    user_id INTEGER,
    user_email TEXT,
    user_name TEXT,
    captured_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ocr JSONB,
    ocr_status TEXT NOT NULL DEFAULT 'WAITING' CHECK (ocr_status IN ('WAITING', 'READ', 'FAILED', 'OFF')),
    ocr_error TEXT,
    read_at TIMESTAMPTZ,
    bill_id INTEGER,
    decided_by TEXT,
    decided_at TIMESTAMPTZ,
    reason TEXT
  )`);
  await exec(`CREATE INDEX IF NOT EXISTS bill_scans_status_idx ON bill_scans (status, created_at DESC)`);
}

// ---------------------------------------------------------------------------
// The rules, without a database (unit-tested).

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const text = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();
export const MAX_PAGES = 8;
const MAX_PAGE_BYTES = 6 * 1024 * 1024;

/** Checks the pages the phone sent: photos as data: URLs (JPEG, PNG or WebP), up to 8, each up to 6 MB. */
export function checkPages(raw: unknown): string[] {
  const pages = Array.isArray(raw) ? raw : [];
  if (!pages.length) throw fail(400, 'Take a photo of the bill first.');
  if (pages.length > MAX_PAGES) throw fail(400, `Up to ${MAX_PAGES} pages per bill.`);
  return pages.map((p, i) => {
    const m = typeof p === 'string' ? /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(p) : null;
    if (!m) throw fail(400, `Page ${i + 1} isn't a photo.`);
    if ((m[2].length * 3) / 4 > MAX_PAGE_BYTES) throw fail(413, `Page ${i + 1} is too large: take it again a little further away.`);
    return p as string;
  });
}

/** A company name for comparing: lower case, without (Pty) Ltd, CC, Inc and punctuation. */
export const companyKey = (s: unknown) => text(s).toLowerCase()
  .replace(/\((pty|proprietary)\)/g, ' ').replace(/\b(pty|proprietary|ltd|limited|cc|inc|incorporated|llc|gmbh|co|company|sa|za|the)\b/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ').trim();

export interface SupplierRow { id: string; name: string | null; vat_number?: string | null; website?: string | null; contact_email?: string | null }

/** The company part of a web address or email: "info@hdcabling.co.za", "www.hdcabling.co.za" → "hdcabling". Null for free mail. */
export function domainLabel(v: unknown): string | null {
  const host = text(v).toLowerCase().replace(/^.*@/, '').replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[\/:?#]/)[0];
  const label = host.split('.')[0];
  if (!label || label.length < 3 || /^(gmail|yahoo|hotmail|outlook|live|icloud|webmail|mweb|telkomsa|vodamail|absamail)$/.test(label)) return null;
  return label.replace(/[^a-z0-9]/g, '');
}

/**
 * The supplier an invoice is from: by VAT number first; then by name (exact,
 * then one containing the other); then by the domain of the invoice's email
 * or website against the supplier's name, website or email ("hdcabling" is
 * HD Cabling).
 */
export function matchSupplier(o: Pick<BillOcr, 'supplier' | 'supplierVatNumber'> & Partial<Pick<BillOcr, 'supplierEmail' | 'supplierWebsite'>>, suppliers: SupplierRow[]): { id: string; name: string; by: 'vat' | 'name' | 'web' } | null {
  const out = (s: SupplierRow, by: 'vat' | 'name' | 'web') => ({ id: String(s.id), name: s.name || String(s.id), by });
  const vat = o.supplierVatNumber;
  if (vat) {
    const hit = suppliers.find(s => tidyVatNumber(s.vat_number) === vat);
    if (hit) return out(hit, 'vat');
  }
  const key = companyKey(o.supplier);
  if (key.length >= 3) {
    const exact = suppliers.filter(s => companyKey(s.name) === key);
    if (exact.length === 1) return out(exact[0], 'name');
    const compact = key.replace(/ /g, '');
    const same = suppliers.filter(s => companyKey(s.name).replace(/ /g, '') === compact);
    if (same.length === 1) return out(same[0], 'name');
    const loose = suppliers.filter(s => { const k = companyKey(s.name); return k.length >= 3 && (k.includes(key) || key.includes(k)); });
    if (loose.length === 1) return out(loose[0], 'name');
  }
  const labels = [...new Set([domainLabel(o.supplierEmail), domainLabel(o.supplierWebsite)].filter(Boolean) as string[])];
  for (const d of labels) {
    const hits = suppliers.filter(s => {
      const name = companyKey(s.name).replace(/ /g, '');
      return (name.length >= 4 && (name === d || (d.startsWith(name) && name.length >= 5) || (name.startsWith(d) && d.length >= 5)))
        || domainLabel(s.website) === d || domainLabel(s.contact_email) === d;
    });
    if (hits.length === 1) return out(hits[0], 'web');
  }
  return null;
}

/** Letters a reader confuses with digits, and the digit each is counted as. */
const LOOKALIKE_FROM = 'ILOQSBZG', LOOKALIKE_TO = '11005826';
/** A part code for comparing: capitals and digits only, look-alike letters as their digits ("3P-I-1C" and "3P-1-1C" match). */
export const codeKey = (s: unknown) => String(s ?? '').toUpperCase().split('').map(ch => { const i = LOOKALIKE_FROM.indexOf(ch); return i < 0 ? ch : LOOKALIKE_TO[i]; }).join('').replace(/[^A-Z0-9]/g, '');

/** A PO number as quoted on an invoice, for comparing: capitals, no spaces. */
export const poKey = (s: unknown) => text(s).toUpperCase().replace(/[\s#:]/g, '');

export interface Proposal { key: FillKey; target: 'bill' | 'supplier'; label: string; current: string | null; value: string }
export type FillKey = 'supplierInvoiceNumber' | 'supplierId' | 'vatNumber' | 'address' | 'phone' | 'email' | 'website' | 'bank';
export const FILL_KEYS: FillKey[] = ['supplierInvoiceNumber', 'supplierId', 'vatNumber', 'address', 'phone', 'email', 'website', 'bank'];

/**
 * What a bill and its supplier are missing that the invoice shows: only
 * fields that are empty now, never a change to one that has a value. Bank
 * details are never taken from an invoice (a changed account on an invoice
 * is a common fraud).
 */
export function missingProposals(
  bill: { supplier_id: string | null; supplier_invoice_number: string | null },
  supplier: { id: string; name: string | null; vat_number: string | null; address: string | null; phone: string | null; contact_email: string | null; website: string | null; bank_account_number?: string | null } | null,
  o: BillOcr,
  match: { id: string; name: string } | null,
): Proposal[] {
  const out: Proposal[] = [];
  const empty = (v: unknown) => !text(v);
  if (empty(bill.supplier_invoice_number) && o.invoiceNumber) out.push({ key: 'supplierInvoiceNumber', target: 'bill', label: 'Supplier invoice number', current: null, value: o.invoiceNumber });
  if (empty(bill.supplier_id) && match) out.push({ key: 'supplierId', target: 'bill', label: 'Supplier', current: null, value: match.id });
  const s = supplier ?? null;
  if (s) {
    const add = (key: FillKey, label: string, current: string | null, value: string | null) => { if (empty(current) && value) out.push({ key, target: 'supplier', label, current: null, value }); };
    add('vatNumber', 'VAT number', s.vat_number, o.supplierVatNumber);
    add('address', 'Address', s.address, o.supplierAddress);
    add('phone', 'Phone', s.phone, o.supplierPhone);
    add('email', 'Email', s.contact_email, o.supplierEmail);
    add('website', 'Website', s.website, o.supplierWebsite);
    // Bank details only for a supplier with no bank account yet; the value is the details as JSON.
    const bank = invoiceBank(o);
    if (bank && empty(s.bank_account_number)) out.push({ key: 'bank', target: 'supplier', label: 'Bank details', current: null, value: JSON.stringify(bank) });
  }
  return out;
}

/** The pages stored on a bill (receipt_image): one bare data: URL, or a JSON array of them. */
export function billPages(v: unknown): string[] {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return [];
  if (s.startsWith('[')) { try { const a = JSON.parse(s); return Array.isArray(a) ? a.filter((x: unknown) => typeof x === 'string' && x.startsWith('data:')) : []; } catch { return []; } }
  return s.startsWith('data:') ? [s] : [];
}
const storePages = (pages: string[]) => (pages.length === 1 ? pages[0] : JSON.stringify(pages));

// ---------------------------------------------------------------------------
// Database work.

type Db = { query: (s: string, p?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

async function whoIs(user: { id: number | null; email: string }) {
  const { rows: [me] } = await query(`SELECT first_name, last_name FROM users WHERE id = $1`, [user?.id ?? null]);
  return { id: user?.id ?? null, email: user?.email ?? 'unknown', name: [me?.first_name, me?.last_name].filter(Boolean).join(' ') || user?.email || 'unknown' };
}

/** What an invoice that was read matches in Tracklab: the supplier, the PO, each line's stock item, and the due date from the supplier's terms. */
export async function matchesFor(db: Db, o: BillOcr | null) {
  if (!o) return null;
  const { rows: suppliers } = await db.query(`SELECT id, name, vat_number, website, contact_email, payment_terms_days FROM suppliers`);
  const supplier = matchSupplier(o, suppliers);
  let po: { id: number; number: string; supplierId: string | null; status: string } | null = null;
  if (o.poNumber) {
    const { rows: [p] } = await db.query(`SELECT id, po_number, supplier_id, status FROM purchase_orders WHERE upper(replace(po_number, ' ', '')) = $1`, [poKey(o.poNumber)]);
    if (p) po = { id: p.id, number: p.po_number, supplierId: p.supplier_id, status: p.status };
  }
  // Each line's code to a stock item: by its stock code or a maker's / supplier's part number, with
  // letters a reader confuses with digits counted the same ("XY-CC211-3P-1-1C" is XY-CC211-3P-I-1C).
  const codes = [...new Set(o.lineItems.map(l => l.partNumber).filter(Boolean) as string[])];
  const items = new Map<string, string>();
  if (codes.length) {
    const keys = codes.map(codeKey);
    const k = (col: string) => `regexp_replace(translate(upper(coalesce(${col}, '')), '${LOOKALIKE_FROM}', '${LOOKALIKE_TO}'), '[^A-Z0-9]', '', 'g')`;
    const cols = ['serial_number', 'man_pn_1', 'man_pn_2', 'man_pn_3', 'sup_pn_1', 'sup_pn_2', 'sup_pn_3'];
    const { rows } = await db.query(
      `SELECT serial_number, ${cols.map((c, i) => `${k(c)} AS k${i}`).join(', ')} FROM inventory
        WHERE deleted IS NOT TRUE AND (${cols.map(c => `${k(c)} = ANY($1)`).join(' OR ')})`, [keys]);
    for (const c of codes) {
      const key = codeKey(c);
      if (key.length < 4) continue;
      // An exact stock code wins; else the one item whose code or part number reads the same.
      const exact = rows.filter((r: any) => String(r.serial_number).toUpperCase() === c.toUpperCase());
      const hits = exact.length ? exact : rows.filter((r: any) => cols.some((_, i) => r[`k${i}`] === key));
      const distinct = [...new Set(hits.map((r: any) => r.serial_number))];
      if (distinct.length === 1) items.set(c.toUpperCase(), distinct[0] as string);
    }
  }
  // What this supplier's earlier bills taught (./billLearning): stock items, descriptions, accounts, the invoice number's shape, due days.
  const learned = supplier ? applyProfile(o, await profileFor(db, supplier.id).catch(() => null)) : null;
  const terms = supplier ? Number(suppliers.find((s: any) => String(s.id) === supplier.id)?.payment_terms_days) || null : null;
  const days = learned?.dueDays ?? terms;
  let dueDate = o.dueDate;
  if (!dueDate && o.date && days) { const d = new Date(`${o.date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); dueDate = d.toISOString().slice(0, 10); }
  return {
    supplier, po, dueDate,
    invoiceNumber: learned?.invoiceNumber ?? o.invoiceNumber,
    learnedFrom: learned?.learnedFrom ?? 0,
    lines: o.lineItems.map((l, i) => {
      const hint = learned?.lines[i];
      const byCode = l.partNumber ? items.get(l.partNumber.toUpperCase()) ?? null : null;
      return { partNumber: l.partNumber, item: (hint?.learned ? hint.item : null) ?? byCode, description: hint?.description ?? null, accountId: hint?.accountId ?? null, taxRateId: hint?.taxRateId ?? null, learned: !!hint?.learned };
    }),
  };
}

const toScan = async (db: Db, r: any, withPages: boolean) => {
  const pages: string[] = Array.isArray(r.pages) ? r.pages : [];
  const ocr: BillOcr | null = r.ocr || null;
  return {
    id: r.id as number, status: r.status as 'INBOX' | 'USED' | 'DISCARDED',
    pageCount: pages.length, thumb: pages[0] ?? null, ...(withPages ? { pages } : {}),
    note: r.note as string | null,
    user: { id: r.user_id as number | null, name: (r.user_name || r.user_email || 'Unknown') as string },
    capturedAt: r.captured_at, createdAt: r.created_at,
    read: { status: r.ocr_status as 'WAITING' | 'READ' | 'FAILED' | 'OFF', error: r.ocr_error as string | null, at: r.read_at },
    ocr, warnings: ocr ? ocrWarnings(ocr) : [],
    match: r.ocr_status === 'READ' ? await matchesFor(db, ocr) : null,
    billId: r.bill_id as number | null, billNumber: (r.bill_number ?? null) as string | null,
    decidedBy: r.decided_by as string | null, decidedAt: r.decided_at, reason: r.reason as string | null,
  };
};

const SCAN_SQL = `SELECT s.*, b.bill_number FROM bill_scans s LEFT JOIN bills b ON b.id = s.bill_id`;

/** Reads a scanned bill and saves what was read. Never throws: a failure is saved on the scan. */
export async function readScan(id: number): Promise<void> {
  const { rows: [r] } = await query(`SELECT pages FROM bill_scans WHERE id = $1`, [id]);
  if (!r) return;
  if (!ocrAvailable()) { await query(`UPDATE bill_scans SET ocr_status = 'OFF', ocr_error = 'Reading bills is not set up on this server.' WHERE id = $1`, [id]); return; }
  try {
    const o = await readBill(r.pages);
    await query(`UPDATE bill_scans SET ocr = $2, ocr_status = 'READ', ocr_error = NULL, read_at = now() WHERE id = $1`, [id, JSON.stringify(o)]);
  } catch (e: any) {
    await query(`UPDATE bill_scans SET ocr_status = $2, ocr_error = $3, read_at = now() WHERE id = $1`, [id, e?.status === 501 ? 'OFF' : 'FAILED', String(e?.message || 'Could not read it.').slice(0, 300)]).catch(() => {});
  }
}

async function loadScan(id: number, withPages = false) {
  const { rows: [r] } = await query(`${SCAN_SQL} WHERE s.id = $1`, [id]);
  return r ? toScan(pool as any, r, withPages) : null;
}
async function openScan(db: Db, id: number) {
  const { rows: [r] } = await db.query(`SELECT * FROM bill_scans WHERE id = $1 FOR UPDATE`, [id]);
  if (!r) throw fail(404, 'That scanned bill no longer exists.');
  if (r.status !== 'INBOX') throw fail(409, r.status === 'USED' ? 'That scanned bill has already been used.' : 'That scanned bill was discarded.');
  return r;
}

/**
 * A supplier's bank details from their invoice, only when the supplier has no
 * bank account yet (never a change: a changed account on an invoice is a common
 * fraud). Stamped and logged like any banking change, so the vendor shows
 * "changed recently" and asks for a phone check before paying.
 * 'filled'; 'differs' when the supplier has another account; null otherwise.
 */
export async function fillSupplierBank(db: Db, supplierId: string, raw: unknown, who: string | null, from: string): Promise<'filled' | 'differs' | null> {
  const bank = tidyInvoiceBank(raw);
  if (!bank) return null;
  const { rows: [s] } = await db.query(`SELECT bank_account_number FROM suppliers WHERE id = $1 FOR UPDATE`, [supplierId]);
  if (!s) return null;
  const have = text(s.bank_account_number).replace(/[\s-]/g, '');
  if (have) return have === bank.accountNumber ? null : 'differs';
  const by = `${who || 'unknown'} (from ${from})`;
  await db.query(
    `UPDATE suppliers SET bank_name = $2, bank_account_number = $3, bank_branch_code = $4, bank_account_type = $5, bank_swift = $6, bank_updated_at = now(), bank_updated_by = $7 WHERE id = $1`,
    [supplierId, bank.bankName, bank.accountNumber, bank.branchCode, bank.accountType, bank.swift, by.slice(0, 200)]);
  await db.query(
    `INSERT INTO user_activity_logs (user_email, action, entity_type, entity_id, details, status) VALUES ((SELECT email FROM users WHERE email = $1), 'UPDATE_SUPPLIER_BANKING', 'Supplier', $2, $3, 'SUCCESS')`,
    [who, supplierId, JSON.stringify({ changed: ['bankName', 'accountNumber', 'branchCode', 'accountType', 'swift'], by, fromInvoice: from, accountBefore: null, accountAfter: maskAccount(bank.accountNumber), bankAfter: bank.bankName })]);
  return 'filled';
}

/** What fillSupplierGaps did to the bank details, in words for the person (or null). */
export const bankNote = (r: 'filled' | 'differs' | null, bank: InvoiceBank | null) =>
  r === 'filled' ? `Bank details saved from the invoice (${describeBank(bank)}): confirm them by phone before the first payment.`
    : r === 'differs' ? `The invoice shows bank account ${maskAccount(bank?.accountNumber)}, not the one on the supplier: left unchanged. If they've changed banks, confirm by phone before changing it.`
      : null;

/** Fills a supplier's empty contact fields (and bank details, when it has none) from what an invoice showed. Returns the fields filled. */
export async function fillSupplierGaps(db: Db, supplierId: string, values: Partial<Record<'vatNumber' | 'address' | 'phone' | 'email' | 'website', string | null>> & { bank?: unknown }, meta?: { who: string | null; from: string; notes?: string[] }): Promise<string[]> {
  const cols: Record<string, string> = { vatNumber: 'vat_number', address: 'address', phone: 'phone', email: 'contact_email', website: 'website' };
  const filled: string[] = [];
  for (const [k, col] of Object.entries(cols)) {
    const v = text((values as any)[k]).slice(0, k === 'address' ? 300 : 120);
    if (!v) continue;
    const r = await db.query(`UPDATE suppliers SET ${col} = $2 WHERE id = $1 AND (${col} IS NULL OR trim(${col}) = '')`, [supplierId, k === 'vatNumber' ? tidyVatNumber(v) ?? v : v]);
    if (r.rowCount) filled.push(k);
  }
  if (values.bank && meta) {
    const r = await fillSupplierBank(db, supplierId, values.bank, meta.who, meta.from);
    if (r === 'filled') filled.push('bank');
    const note = bankNote(r, tidyInvoiceBank(values.bank));
    if (note) meta.notes?.push(note);
  }
  return filled;
}

/** Everything a read invoice shows about its supplier, for fillSupplierGaps. */
const supplierValues = (o: BillOcr, withBank: boolean) => ({ vatNumber: o.supplierVatNumber, address: o.supplierAddress, phone: o.supplierPhone, email: o.supplierEmail, website: o.supplierWebsite, bank: withBank ? invoiceBank(o) : null });
/** Bank details are saved only by someone who may change suppliers (as on the Suppliers page). */
const mayBank = (req: any) => roleCan(req.user?.role, 'suppliers.update');

const send = (res: Response, e: any, what: string) => {
  // A reader that isn't set up (501) or failed (502) says why: the message is ours, not a stack.
  if (e?.status && (e.status < 500 || e.status === 501 || e.status === 502)) return res.status(e.status).json({ error: e.message });
  console.error(`[bill-scans] ${what} failed:`, e?.message);
  res.status(500).json({ error: `Could not ${what}. Please try again.` });
};
/** A new supplier's details from the form: a name is needed; the rest tidied, empty as null. */
export function newSupplierFrom(b: any) {
  const t = (k: string, max: number) => text(b?.[k]).replace(/\s+/g, ' ').slice(0, max) || null;
  const name = t('name', 120);
  if (!name || name.length < 2) throw fail(400, "Type the supplier's name.");
  const vat = t('vatNumber', 30);
  const email = t('email', 120);
  if (email && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) throw fail(400, `"${email}" isn't an email address.`);
  return { name, vatNumber: vat ? tidyVatNumber(vat) ?? vat : null, address: t('address', 300), phone: t('phone', 60), email, website: t('website', 120) };
}
const idOf = (v: unknown) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw fail(400, 'Not a valid id.'); return n; };
async function inTx<T>(fn: (c: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const r = await fn(client as any); await client.query('COMMIT'); return r; }
  catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}

export function registerBillScansRoutes(app: Express): void {
  app.post('/api/bill-scans', async (req: any, res) => {
    try {
      const pages = checkPages(req.body?.pages);
      const ref = text(req.body?.clientRef);
      if (ref && !/^[A-Za-z0-9._:-]{8,80}$/.test(ref)) throw fail(400, 'clientRef must be 8 to 80 letters, digits or . _ : -');
      if (ref) {
        const { rows: [dup] } = await query(`${SCAN_SQL} WHERE s.client_ref = $1`, [ref]);
        if (dup) return res.status(200).json({ ...(await toScan(pool as any, dup, false)), alreadySaved: true });
      }
      const t = Date.parse(String(req.body?.capturedAt ?? ''));
      const capturedAt = Number.isFinite(t) && t <= Date.now() + 300_000 ? new Date(t).toISOString() : null;
      const who = await whoIs(req.user);
      const { rows: [r] } = await query(
        `INSERT INTO bill_scans (client_ref, pages, note, user_id, user_email, user_name, captured_at, ocr_status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [ref || null, JSON.stringify(pages), text(req.body?.note).slice(0, 300) || null, who.id, who.email, who.name, capturedAt, ocrAvailable() ? 'WAITING' : 'OFF']);
      res.status(201).json(await loadScan(r.id));
      // Read it now, after answering: the phone doesn't wait for it.
      if (ocrAvailable()) setImmediate(() => { void readScan(r.id); });
    } catch (e) { send(res, e, 'save the scanned bill'); }
  });

  app.get('/api/bill-scans', async (req: any, res) => {
    try {
      const status = text(req.query.status).toUpperCase();
      const mine = text(req.query.mine) === '1';
      const { rows } = await query(
        `${SCAN_SQL} WHERE ($1 = 'ALL' OR s.status = $1) AND ($2::int IS NULL OR s.user_id = $2) ORDER BY s.created_at DESC LIMIT 100`,
        [['INBOX', 'USED', 'DISCARDED', 'ALL'].includes(status) ? status : 'INBOX', mine ? req.user?.id ?? -1 : null]);
      const items = [];
      for (const r of rows) items.push(await toScan(pool as any, r, false));
      res.json({ items, ocr: ocrAvailable() });
    } catch (e) { send(res, e, 'load the scanned bills'); }
  });

  app.get('/api/bill-scans/:id', async (req, res) => {
    try {
      const s = await loadScan(idOf(req.params.id), true);
      if (!s) return res.status(404).json({ error: 'That scanned bill no longer exists.' });
      res.json(s);
    } catch (e) { send(res, e, 'load the scanned bill'); }
  });

  app.post('/api/bills/inbox/:id/read', async (req, res) => {
    try {
      const id = idOf(req.params.id);
      if (!ocrAvailable()) throw fail(501, 'Reading bills is not set up on this server (no Mindee or OpenAI key).');
      await query(`UPDATE bill_scans SET ocr_status = 'WAITING', ocr_error = NULL WHERE id = $1`, [id]);
      await readScan(id);
      res.json(await loadScan(id));
    } catch (e) { send(res, e, 'read the scanned bill'); }
  });

  app.post('/api/bills/inbox/:id/discard', async (req: any, res) => {
    try {
      const id = idOf(req.params.id);
      const who = await whoIs(req.user);
      await inTx(async (c) => {
        await openScan(c, id);
        await c.query(`UPDATE bill_scans SET status = 'DISCARDED', decided_by = $2, decided_at = now(), reason = $3 WHERE id = $1`, [id, who.name, text(req.body?.reason).slice(0, 300) || null]);
      });
      res.json(await loadScan(id));
    } catch (e) { send(res, e, 'discard the scanned bill'); }
  });

  // Its pages go on a bill that exists (after the ones already there), and
  // what that bill misses (the supplier's invoice number) is filled in, and
  // what its supplier misses (VAT number, contact, bank details) too.
  app.post('/api/bills/inbox/:id/attach', async (req: any, res) => {
    try {
      const id = idOf(req.params.id);
      const billId = idOf(req.body?.billId);
      const who = await whoIs(req.user);
      const out = await inTx(async (c) => {
        const s = await openScan(c, id);
        const { rows: [b] } = await c.query(`SELECT id, bill_number, supplier_id, receipt_image, supplier_invoice_number FROM bills WHERE id = $1 FOR UPDATE`, [billId]);
        if (!b) throw fail(404, 'That bill no longer exists.');
        const pages = [...billPages(b.receipt_image), ...s.pages];
        if (pages.length > 16) throw fail(400, `${b.bill_number} would have ${pages.length} pages: 16 at most.`);
        const inv = !text(b.supplier_invoice_number) && s.ocr?.invoiceNumber ? s.ocr.invoiceNumber : null;
        await c.query(`UPDATE bills SET receipt_image = $2, supplier_invoice_number = COALESCE($3, supplier_invoice_number), updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [billId, storePages(pages), inv]);
        const notes: string[] = [];
        const supplierFilled = b.supplier_id && s.ocr ? await fillSupplierGaps(c, String(b.supplier_id), supplierValues(s.ocr, mayBank(req)), { who: req.user?.email ?? null, from: `the invoice on ${b.bill_number}`, notes }) : [];
        await c.query(`UPDATE bill_scans SET status = 'USED', bill_id = $2, decided_by = $3, decided_at = now() WHERE id = $1`, [id, billId, who.name]);
        return { billNumber: b.bill_number as string, pages: pages.length, invoiceNumber: inv, supplierFilled, notes };
      });
      res.json({ ...out, scan: await loadScan(id) });
    } catch (e) { send(res, e, 'attach the scanned bill'); }
  });

  // The invoice is from a supplier Tracklab doesn't have: add it, with what the
  // invoice shows (checked and corrected on the website first: a reader can
  // misread a name). Refused when it matches a supplier already there.
  app.post('/api/bills/inbox/:id/add-supplier', async (req: any, res) => {
    try {
      const id = idOf(req.params.id);
      if (!roleCan(req.user?.role, 'suppliers.update')) throw fail(403, notAllowedMessage('suppliers.update'));
      const v = newSupplierFrom(req.body);
      const supplier = await inTx(async (c) => {
        await openScan(c, id);
        // One new supplier id at a time (ids are 1, 2, 3...).
        await c.query(`LOCK TABLE suppliers IN SHARE ROW EXCLUSIVE MODE`);
        const { rows: all } = await c.query(`SELECT id, name, vat_number, website, contact_email FROM suppliers`);
        const same = matchSupplier({ supplier: v.name, supplierVatNumber: v.vatNumber, supplierEmail: v.email, supplierWebsite: v.website }, all);
        if (same && same.by !== 'web') throw fail(409, `${same.name} is already a supplier${same.by === 'vat' ? ' with that VAT number' : ''}.`);
        const next = all.reduce((m: number, s: any) => Math.max(m, /^\d+$/.test(String(s.id)) ? Number(s.id) : 0), 0) + 1;
        const { rows: [row] } = await c.query(
          `INSERT INTO suppliers (id, name, vat_number, address, phone, contact_email, website, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
          [String(next), v.name, v.vatNumber, v.address, v.phone, v.email ?? '', v.website ?? '', `Added from a scanned bill (scan ${id}).`]);
        await c.query(`INSERT INTO user_activity_logs (user_email, action, entity_type, entity_id, details, status) VALUES ((SELECT email FROM users WHERE email = $1), 'CREATE', 'Supplier', $2, $3, 'SUCCESS')`,
          [req.user?.email ?? null, String(next), JSON.stringify({ name: v.name, fromBillScan: id })]);
        // The bank details the invoice shows (the reader's; the form can't change them).
        const { rows: [sc] } = await c.query(`SELECT ocr FROM bill_scans WHERE id = $1`, [id]);
        const bank = invoiceBank(sc?.ocr);
        const r = bank ? await fillSupplierBank(c, String(next), bank, req.user?.email ?? null, `scanned bill ${id}`) : null;
        const { rows: [saved] } = await c.query(`SELECT * FROM suppliers WHERE id = $1`, [String(next)]);
        return { ...saved, bank_note: bankNote(r, bank) };
      });
      res.status(201).json({ supplier, scan: await loadScan(id) });
    } catch (e) { send(res, e, 'add the supplier'); }
  });

  // A bill was made from it on the website: its photos go on the bill (when
  // the bill has none yet), and the supplier's empty details are filled from
  // the invoice when asked.
  app.post('/api/bills/inbox/:id/used', async (req: any, res) => {
    try {
      const id = idOf(req.params.id);
      const billId = idOf(req.body?.billId);
      const who = await whoIs(req.user);
      const out = await inTx(async (c) => {
        const s = await openScan(c, id);
        const { rows: [b] } = await c.query(`SELECT id, supplier_id, receipt_image FROM bills WHERE id = $1 FOR UPDATE`, [billId]);
        if (!b) throw fail(404, 'That bill no longer exists.');
        if (!billPages(b.receipt_image).length) await c.query(`UPDATE bills SET receipt_image = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [billId, storePages(s.pages)]);
        let supplierFilled: string[] = [];
        const notes: string[] = [];
        if (req.body?.fillSupplier && b.supplier_id && s.ocr) {
          supplierFilled = await fillSupplierGaps(c, String(b.supplier_id), supplierValues(s.ocr, mayBank(req)), { who: req.user?.email ?? null, from: `the invoice on bill ${billId}`, notes });
        }
        await c.query(`UPDATE bill_scans SET status = 'USED', bill_id = $2, decided_by = $3, decided_at = now() WHERE id = $1`, [id, billId, who.name]);
        return { supplierFilled, notes };
      });
      res.json({ ...out, scan: await loadScan(id) });
    } catch (e) { send(res, e, 'record the scanned bill'); }
  });

  // ---- Existing bills: read their attached photos for what they and their supplier miss.
  app.post('/api/bills/:id/read-missing', async (req, res) => {
    try {
      const id = idOf(req.params.id);
      const { rows: [b] } = await query(`SELECT id, bill_number, supplier_id, supplier_invoice_number, receipt_image FROM bills WHERE id = $1`, [id]);
      if (!b) throw fail(404, 'That bill no longer exists.');
      const pages = billPages(b.receipt_image).filter(p => p.startsWith('data:image/'));
      if (!pages.length) throw fail(400, `${b.bill_number} has no photos attached to read.`);
      const o = await readBill(pages.slice(0, 8));
      const { rows: [s] } = b.supplier_id ? await query(`SELECT id, name, vat_number, address, phone, contact_email, website, bank_account_number FROM suppliers WHERE id = $1`, [b.supplier_id]) : { rows: [] as any[] };
      const match = await matchesFor(pool as any, o);
      const proposals = missingProposals(b, s ?? null, o, match?.supplier ?? null);
      // The bill's supplier differs from the one the invoice names: say so, change nothing.
      const mismatch = match?.supplier && b.supplier_id && match.supplier.id !== String(b.supplier_id) ? `The invoice looks like it's from ${match.supplier.name}, but the bill is under ${s?.name || b.supplier_id}.` : null;
      res.json({ billId: id, billNumber: b.bill_number, supplier: s ? { id: s.id, name: s.name } : null, ocr: o, proposals, warnings: [...ocrWarnings(o), ...(mismatch ? [mismatch] : [])] });
    } catch (e) { send(res, e, 'read the bill'); }
  });

  app.post('/api/bills/:id/fill-missing', async (req: any, res) => {
    try {
      const id = idOf(req.params.id);
      const values = req.body?.values && typeof req.body.values === 'object' ? req.body.values : {};
      const keys = Object.keys(values).filter((k): k is FillKey => (FILL_KEYS as string[]).includes(k));
      if (!keys.length) throw fail(400, 'Choose something to fill in.');
      const out = await inTx(async (c) => {
        const { rows: [b] } = await c.query(`SELECT id, bill_number, supplier_id, supplier_invoice_number FROM bills WHERE id = $1 FOR UPDATE`, [id]);
        if (!b) throw fail(404, 'That bill no longer exists.');
        const filled: string[] = [];
        const notes: string[] = [];
        if (keys.includes('supplierInvoiceNumber') && !text(b.supplier_invoice_number) && text(values.supplierInvoiceNumber)) {
          await c.query(`UPDATE bills SET supplier_invoice_number = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [id, text(values.supplierInvoiceNumber).slice(0, 60)]);
          filled.push('supplierInvoiceNumber');
        }
        let supplierId = b.supplier_id ? String(b.supplier_id) : null;
        if (keys.includes('supplierId') && !supplierId && text(values.supplierId)) {
          const { rows: [s] } = await c.query(`SELECT id FROM suppliers WHERE id = $1`, [text(values.supplierId)]);
          if (!s) throw fail(400, 'That supplier no longer exists.');
          await c.query(`UPDATE bills SET supplier_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [id, String(s.id)]);
          supplierId = String(s.id); filled.push('supplierId');
        }
        const bank = keys.includes('bank') && mayBank(req) ? (typeof values.bank === 'string' ? (() => { try { return JSON.parse(values.bank); } catch { return null; } })() : values.bank) : null;
        if (supplierId) filled.push(...await fillSupplierGaps(c, supplierId, { vatNumber: keys.includes('vatNumber') ? values.vatNumber : null, address: keys.includes('address') ? values.address : null, phone: keys.includes('phone') ? values.phone : null, email: keys.includes('email') ? values.email : null, website: keys.includes('website') ? values.website : null, bank }, { who: req.user?.email ?? null, from: `the invoice on ${b.bill_number}`, notes }));
        if (filled.length) {
          await c.query(`INSERT INTO user_activity_logs (user_email, action, entity_type, entity_id, details, status) VALUES ((SELECT email FROM users WHERE email = $1), 'FILL_FROM_INVOICE', 'Bill', $2, $3, 'SUCCESS')`,
            [req.user?.email ?? null, b.bill_number, JSON.stringify({ filled, supplierId, by: req.user?.email ?? null })]);
        }
        return { billNumber: b.bill_number as string, filled, notes };
      });
      res.json(out);
    } catch (e) { send(res, e, 'fill in the bill'); }
  });
}
