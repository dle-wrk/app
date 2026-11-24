// Reading a supplier invoice / bill / till slip from its photos, for: the
// website's "Scan receipt" (POST /api/bookkeeping/ocr/receipt), bills sent
// from the scanner (./billScans), and filling in what existing bills and
// suppliers are missing.
//
// Two readers, chosen by the server's settings:
//   Mindee (invoice extraction model, API v2): MINDEE_API_KEY and MINDEE_MODEL_ID.
//     Each page is sent on its own (the API takes one image per request) and
//     the pages' results are put together (mergePages). Mindee keeps the
//     results 12 h by default and doesn't train on them.
//   OpenAI Vision (gpt-4o): OPENAI_API_KEY.
//   Tracklab's own server (./localOcr): Tesseract, free, no key, the photos
//     stay on the server; header and totals only, not the lines.
// They're tried in that order, each the fallback of the one before; the
// server's own reader is always there, so a bill is always read (perhaps
// thinly). BILL_READER=openai or =local puts that one first.

export interface BillOcrLine { description: string; partNumber: string | null; quantity: number; unitPrice: number; lineTotal: number }
export interface BillOcr {
  supplier: string | null;
  supplierVatNumber: string | null;
  supplierAddress: string | null;
  supplierPhone: string | null;
  supplierEmail: string | null;
  supplierWebsite: string | null;
  invoiceNumber: string | null;
  date: string | null;
  dueDate: string | null;
  poNumber: string | null;
  currency: string | null;
  subtotal: number | null;
  taxTotal: number | null;
  total: number | null;
  lineItems: BillOcrLine[];
  text: string;
  /** The supplier's bank details, as printed (./invoiceBank). */
  bank?: InvoiceBank | null;
  /** Which reader read it. */
  reader?: Reader;
}

import { parseBillText, recogniseText } from './localOcr';
import { bankFromText, tidyInvoiceBank, type InvoiceBank } from './invoiceBank';

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

export type Reader = 'mindee' | 'openai' | 'local';
/** A bill can always be read: the server's own reader needs nothing set up. */
export const ocrAvailable = () => readerOrder().length > 0;

/** The readers to try, in order: Mindee, OpenAI, the server's own (each when set up); BILL_READER names one to put first. */
export function readerOrder(env: Record<string, string | undefined> = process.env): Reader[] {
  const has: Record<Reader, boolean> = { mindee: !!env.MINDEE_API_KEY && !!env.MINDEE_MODEL_ID, openai: !!env.OPENAI_API_KEY, local: String(env.BILL_READER_LOCAL || '').toLowerCase() !== 'off' };
  const pref = String(env.BILL_READER || '').toLowerCase() as Reader;
  const order: Reader[] = ['mindee', 'openai', 'local'];
  if (order.includes(pref)) order.sort((a, b) => (a === pref ? -1 : b === pref ? 1 : 0));
  return order.filter(r => has[r]);
}

export const SYSTEM_PROMPT = `You extract structured data from photos of a supplier invoice, bill, credit card slip or till slip (one document, possibly several pages).
Return JSON matching this shape exactly:
{
  "supplier": string | null,          // Trading name of the seller (who issued the invoice), not the buyer.
  "supplierVatNumber": string | null, // The SELLER's VAT / tax registration number, digits as printed. Not the buyer's.
  "supplierAddress": string | null,   // The seller's street or postal address, one line, commas between parts.
  "supplierPhone": string | null,     // The seller's phone number.
  "supplierEmail": string | null,     // The seller's email address.
  "supplierWebsite": string | null,   // The seller's website.
  "invoiceNumber": string | null,     // The seller's invoice / tax invoice / document number.
  "date": string | null,              // Invoice date, ISO YYYY-MM-DD.
  "dueDate": string | null,           // Payment due date if printed, ISO YYYY-MM-DD.
  "poNumber": string | null,          // The buyer's purchase order number if quoted ("Your ref", "PO", "Order no").
  "currency": string | null,          // "ZAR", "USD", "EUR", ... infer from symbols if not stated.
  "subtotal": number | null,          // Total before VAT.
  "taxTotal": number | null,          // VAT / GST amount.
  "total": number | null,             // Grand total owed, VAT included.
  "lineItems": [                      // Each purchased line. Skip subtotal, tax, discount summary and payment rows. Keep delivery as a line.
    { "description": string, "partNumber": string | null, "quantity": number, "unitPrice": number, "lineTotal": number }
  ],                                  // partNumber: the manufacturer's or supplier's part / stock code on that line, if any.
  "bank": { "bankName": string | null, "accountNumber": string | null, "branchCode": string | null, "accountType": string | null, "swift": string | null } | null,
                                      // The SELLER's banking details for payment, as printed ("Our banking details"). Never the buyer's account number.
  "text": string                      // All readable text from every page, in reading order.
}
Unit prices exclude VAT when the invoice shows them that way. If a field is unreadable, use null (or [] for lineItems). Never invent values; never take the buyer's details for the seller's.`;

const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = parseFloat(String(v ?? '').replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown, max = 200): string | null => {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  return s ? s.slice(0, max) : null;
};
const isoDate = (v: unknown): string | null => {
  const s = str(v, 20);
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)) ? s : null;
};
/** A VAT number as printed, tidied: digits (and letters for foreign ones), no spaces or labels. */
export const tidyVatNumber = (v: unknown): string | null => {
  const s = str(v, 40)?.replace(/^(vat|tax)\s*(reg(istration)?)?\s*(no|number|#)?[:.\s]*/i, '').replace(/[\s.\-]/g, '').toUpperCase() ?? null;
  return s && /^[A-Z0-9]{6,20}$/.test(s) ? s : null;
};

/** What the model returned, coerced to a BillOcr: a field that isn't usable is null. */
export function normaliseBillOcr(parsed: any): BillOcr {
  const lines: BillOcrLine[] = Array.isArray(parsed?.lineItems) ? parsed.lineItems.map((li: any) => ({
    description: str(li?.description, 300) || '',
    partNumber: str(li?.partNumber, 80),
    quantity: num(li?.quantity) || 1,
    unitPrice: num(li?.unitPrice) || 0,
    lineTotal: num(li?.lineTotal) || 0,
  })).filter((li: BillOcrLine) => li.description || li.lineTotal > 0) : [];
  const email = str(parsed?.supplierEmail, 120);
  const cur = str(parsed?.currency, 10)?.toUpperCase() ?? null;
  const text = str(parsed?.text, 20000) || '';
  const vat = tidyVatNumber(parsed?.supplierVatNumber);
  return {
    supplier: str(parsed?.supplier, 120),
    supplierVatNumber: vat,
    supplierAddress: str(parsed?.supplierAddress, 300),
    supplierPhone: str(parsed?.supplierPhone, 40),
    supplierEmail: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email.toLowerCase() : null,
    supplierWebsite: str(parsed?.supplierWebsite, 120),
    invoiceNumber: str(parsed?.invoiceNumber, 60),
    date: isoDate(parsed?.date),
    dueDate: isoDate(parsed?.dueDate),
    poNumber: str(parsed?.poNumber, 60),
    currency: cur && /^[A-Z]{3}$/.test(cur) ? cur : null,
    subtotal: num(parsed?.subtotal),
    taxTotal: num(parsed?.taxTotal),
    total: num(parsed?.total),
    lineItems: lines,
    text,
    // The reader's own, else found in the text (Tracklab's own reader has only the text).
    bank: tidyInvoiceBank(parsed?.bank) ?? bankFromText(text, [vat]),
  };
}

/** Things that don't add up on what was read, for the person checking it. */
export function ocrWarnings(o: BillOcr): string[] {
  const w: string[] = [];
  if (o.reader === 'local') w.push("Read by Tracklab's own reader (free, on the server): it can misread a photo, and a line can come out split, joined or missed. Check every field and line against the invoice.");
  const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.05, Math.abs(b) * 0.01);
  if (o.subtotal != null && o.taxTotal != null && o.total != null && !near(o.subtotal + o.taxTotal, o.total)) {
    w.push(`Subtotal ${o.subtotal.toFixed(2)} + VAT ${o.taxTotal.toFixed(2)} doesn't equal the total ${o.total.toFixed(2)}.`);
  }
  const sum = o.lineItems.reduce((s, l) => s + l.lineTotal, 0);
  if (o.lineItems.length && o.total != null && !near(sum, o.total) && !(o.subtotal != null && near(sum, o.subtotal)) && !(o.taxTotal != null && near(sum + o.taxTotal, o.total))) {
    w.push(`The lines add up to ${sum.toFixed(2)}, which matches neither the subtotal nor the total: a line may be missing or misread.`);
  }
  const base = o.subtotal ?? (o.total != null && o.taxTotal != null ? o.total - o.taxTotal : null);
  if (base && o.taxTotal && (o.currency ?? 'ZAR') === 'ZAR' && !near(o.taxTotal, base * 0.15)) {
    w.push(`VAT of ${o.taxTotal.toFixed(2)} isn't 15% of ${base.toFixed(2)}: check it (some lines may be zero-rated).`);
  }
  if (!o.supplierVatNumber && o.taxTotal) w.push('VAT is charged but no supplier VAT number was found: a valid tax invoice must show it.');
  return w;
}

/**
 * Reads the photos (data: URLs) with the first reader that's set up, falling
 * back to the other when it fails. Throws 501 when no reader is set up, 400
 * for no photos, 502 when every reader failed.
 */
export async function readBill(images: string[]): Promise<BillOcr> {
  const order = readerOrder();
  if (!order.length) throw fail(501, 'Reading bills is not set up on this server (no MINDEE_API_KEY + MINDEE_MODEL_ID, or OPENAI_API_KEY).');
  const pages = images.filter((i) => typeof i === 'string' && i.startsWith('data:image/'));
  if (!pages.length) throw fail(400, 'There are no photos to read.');
  if (pages.length > 8) throw fail(400, 'Up to 8 pages can be read at once.');
  // Each reader's reason, so the person sees why (a bad key, no credits, a network failure), not just "failed".
  const reasons: string[] = [];
  for (const r of order) {
    try {
      const o = r === 'mindee' ? await readWithMindee(pages) : r === 'openai' ? await readWithOpenAI(pages) : normaliseBillOcr(parseBillText(await recogniseText(pages)));
      return { ...o, reader: r };
    } catch (e: any) {
      const why = readerError(e);
      console.error(`[ocr:bill] ${r} failed:`, why, e?.cause?.code ?? '');
      reasons.push(`${READER_NAME[r]}: ${why}`);
    }
  }
  throw fail(502, `Could not read the bill. ${reasons.join(' ')}`.trim());
}

const READER_NAME: Record<Reader, string> = { mindee: 'Mindee', openai: 'OpenAI', local: "Tracklab's own reader" };

/** Why a reader failed, in words: its own message, or what went wrong reaching it. */
export function readerError(e: any): string {
  const m = String(e?.message || '').trim();
  if (e?.status) return m.replace(/\.?$/, '.');
  const code = e?.cause?.code || e?.code;
  if (e?.name === 'AbortError' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') return 'it did not answer in time.';
  if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'ECONNRESET' || m === 'fetch failed') return `it could not be reached${code ? ` (${code})` : ''}.`;
  return m ? `${m.replace(/\.?$/, '')}.` : 'it failed without saying why.';
}

async function readWithOpenAI(pages: string[]): Promise<BillOcr> {
  const apiKey = process.env.OPENAI_API_KEY as string;
  const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 4096,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: [{ type: 'text', text: 'Extract the invoice data as JSON.' }, ...pages.map((url) => ({ type: 'image_url', image_url: { url, detail: 'high' } }))] },
      ],
    }),
  });
  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '');
    console.error('[ocr:bill] OpenAI', upstream.status, errText.slice(0, 300));
    throw fail(502, `The reading service refused the photos (${upstream.status}).`);
  }
  const data: any = await upstream.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw fail(502, 'The reading service returned nothing.');
  try { return normaliseBillOcr(JSON.parse(content)); } catch { throw fail(502, 'The reading service returned something that is not JSON.'); }
}

// ---------------------------------------------------------------------------
// Mindee (API v2): enqueue each page, poll its job, read its fields.

const MINDEE = 'https://api-v2.mindee.net/v2';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** A Mindee field's plain value: a simple field's value; a nested object's parts joined; a list's values joined. */
function plain(node: any): unknown {
  if (node == null) return null;
  if (typeof node !== 'object') return node;
  if ('value' in node && node.value != null) return node.value;
  if (Array.isArray(node.items)) {
    const vals = node.items.map(plain).filter((v: unknown) => v != null && String(v).trim());
    return vals.length ? vals.map(String).join(', ') : null;
  }
  if (node.fields && typeof node.fields === 'object') {
    const vals = Object.values(node.fields).map(plain).filter(v => v != null && String(v).trim());
    return vals.length ? vals.map(String).join(', ') : null;
  }
  return null;
}
/** The first of these field names the result has a value for. */
function pick(fields: any, names: string[]): unknown {
  for (const n of names) { const v = plain(fields?.[n]); if (v != null && String(v).trim() !== '') return v; }
  return null;
}
/** The supplier's VAT / tax number out of Mindee's registrations list: the one typed VAT first, else the first. */
function vatFrom(fields: any): unknown {
  for (const n of ['supplier_company_registrations', 'supplier_company_registration', 'supplier_registrations']) {
    const items: any[] = fields?.[n]?.items ?? [];
    if (!items.length) continue;
    const typed = items.find(i => /vat|tax/i.test(String(plain(i?.fields?.type) ?? '')));
    const one = typed ?? items[0];
    const num = plain(one?.fields?.number) ?? plain(one);
    if (num) return num;
  }
  return pick(fields, ['supplier_vat_number', 'supplier_tax_id', 'supplier_tax_number', 'vat_number', 'tax_id']);
}

/**
 * One page's Mindee result (inference.result.fields) in the reader's own
 * shape, ready for normaliseBillOcr. Field names are those of Mindee's
 * invoice template; close alternatives are tried too.
 */
export function fromMindeeFields(fields: any): Record<string, unknown> {
  const lines: any[] = fields?.line_items?.items ?? [];
  return {
    supplier: pick(fields, ['supplier_name', 'vendor_name', 'supplier']),
    supplierVatNumber: vatFrom(fields),
    supplierAddress: pick(fields, ['supplier_address', 'vendor_address']),
    supplierPhone: pick(fields, ['supplier_phone_number', 'supplier_phone', 'vendor_phone']),
    supplierEmail: pick(fields, ['supplier_email', 'vendor_email']),
    supplierWebsite: pick(fields, ['supplier_website', 'vendor_website']),
    invoiceNumber: pick(fields, ['invoice_number', 'document_number']),
    date: pick(fields, ['date', 'invoice_date', 'document_date']),
    dueDate: pick(fields, ['due_date', 'payment_due_date']),
    poNumber: pick(fields, ['po_number', 'purchase_order_number', 'purchase_order', 'reference_numbers']),
    currency: plain(fields?.locale?.fields?.currency) ?? pick(fields, ['currency']),
    subtotal: pick(fields, ['total_net', 'subtotal', 'total_excluding_tax']),
    taxTotal: pick(fields, ['total_tax', 'tax_total', 'tax_amount']),
    total: pick(fields, ['total_amount', 'total', 'total_incl_tax']),
    lineItems: lines.map(it => {
      const f = it?.fields ?? {};
      return {
        description: pick(f, ['description', 'name', 'item_description']),
        partNumber: pick(f, ['product_code', 'item_code', 'part_number', 'sku']),
        quantity: pick(f, ['quantity']),
        unitPrice: pick(f, ['unit_price', 'price']),
        lineTotal: pick(f, ['total_price', 'total_amount', 'amount', 'line_total']),
      };
    }),
    bank: (() => {
      const p = (fields?.supplier_payment_details?.items ?? [])[0]?.fields;
      return p ? { accountNumber: plain(p.account_number) ?? plain(p.iban), branchCode: plain(p.routing_number), swift: plain(p.swift), bankName: null, accountType: null } : null;
    })(),
    text: '',
  };
}

/** A multi-page invoice from its pages: details from the first page that has them, totals from the last, every page's lines. */
export function mergePages(pages: BillOcr[]): BillOcr {
  const first = <K extends keyof BillOcr>(k: K) => pages.map(p => p[k]).find(v => v != null && v !== '') ?? null;
  const lastOf = <K extends keyof BillOcr>(k: K) => [...pages].reverse().map(p => p[k]).find(v => v != null) ?? null;
  return {
    supplier: first('supplier') as any, supplierVatNumber: first('supplierVatNumber') as any, supplierAddress: first('supplierAddress') as any,
    supplierPhone: first('supplierPhone') as any, supplierEmail: first('supplierEmail') as any, supplierWebsite: first('supplierWebsite') as any,
    invoiceNumber: first('invoiceNumber') as any, date: first('date') as any, dueDate: first('dueDate') as any, poNumber: first('poNumber') as any,
    currency: first('currency') as any,
    subtotal: lastOf('subtotal') as any, taxTotal: lastOf('taxTotal') as any, total: lastOf('total') as any,
    lineItems: pages.flatMap(p => p.lineItems),
    text: pages.map(p => p.text).filter(Boolean).join('\n\n'),
    bank: first('bank') as any,
  };
}

async function mindeeJson(url: string, init: RequestInit = {}) {
  const res = await fetch(url, { ...init, headers: { Authorization: process.env.MINDEE_API_KEY as string, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) } });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 202) {
    const why = body?.detail || body?.title || body?.error?.message || '';
    console.error('[ocr:mindee]', res.status, String(why).slice(0, 300));
    throw fail(502, res.status === 401 || res.status === 403 ? 'Mindee refused the key (check MINDEE_API_KEY).' : res.status === 402 ? 'The Mindee account is out of credits.' : `Mindee refused the page (${res.status}).`);
  }
  return body;
}

/** One page through Mindee: enqueue, poll until processed (about 90 s at most), fetch the result. */
async function mindeePage(dataUrl: string, n: number, wait = sleep): Promise<BillOcr> {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const ext = /^data:image\/(\w+)/.exec(dataUrl)?.[1] ?? 'jpeg';
  const queued = await mindeeJson(`${MINDEE}/products/extraction/enqueue`, {
    method: 'POST', body: JSON.stringify({ model_id: process.env.MINDEE_MODEL_ID, file_base64: base64, filename: `page-${n}.${ext === 'jpeg' ? 'jpg' : ext}` }),
  });
  const job = queued?.job;
  if (!job?.id) throw fail(502, 'Mindee did not take the page.');
  let resultUrl: string | null = job.result_url ?? null;
  for (let i = 0; i < 60 && !resultUrl; i++) {
    await wait(i < 5 ? 1000 : 2000);
    const st = await mindeeJson(`${MINDEE}/jobs/${job.id}?redirect=false`);
    const s = st?.job?.status;
    if (s === 'Failed') throw fail(502, `Mindee could not read page ${n}${st?.job?.error?.detail ? `: ${st.job.error.detail}` : ''}.`);
    if (s === 'Processed') resultUrl = st.job.result_url || `${MINDEE}/products/extraction/results/${st.job.id}`;
  }
  if (!resultUrl) throw fail(502, `Mindee took too long with page ${n}.`);
  const result = await mindeeJson(resultUrl);
  const fields = result?.inference?.result?.fields ?? {};
  const o = normaliseBillOcr(fromMindeeFields(fields));
  if (!o.supplier && !o.total && !o.invoiceNumber && !o.lineItems.length) {
    console.error('[ocr:mindee] nothing recognised on page', n, '- the model returned fields:', Object.keys(fields).join(', ') || '(none)');
  }
  return o;
}

export async function readWithMindee(pages: string[], wait = sleep): Promise<BillOcr> {
  const read = await Promise.all(pages.map((p, i) => mindeePage(p, i + 1, wait)));
  return mergePages(read);
}
