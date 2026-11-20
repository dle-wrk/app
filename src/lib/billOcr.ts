// Reading a supplier invoice / bill / till slip from its photos with OpenAI
// Vision (gpt-4o), for: the website's "Scan receipt" (POST
// /api/bookkeeping/ocr/receipt), bills sent from the scanner (./billScans),
// and filling in what existing bills and suppliers are missing.
//
// The photos are sent to OpenAI to be read; nothing is kept there beyond
// their usual API retention. Without OPENAI_API_KEY nothing is sent and
// readBill throws a 501, which every caller turns into "not read".

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
}

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

export const ocrAvailable = () => !!process.env.OPENAI_API_KEY;

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
  return {
    supplier: str(parsed?.supplier, 120),
    supplierVatNumber: tidyVatNumber(parsed?.supplierVatNumber),
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
    text: str(parsed?.text, 20000) || '',
  };
}

/** Things that don't add up on what was read, for the person checking it. */
export function ocrWarnings(o: BillOcr): string[] {
  const w: string[] = [];
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

/** Reads the photos (data: URLs). Throws 501 without an API key, 502 when the service fails. */
export async function readBill(images: string[]): Promise<BillOcr> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw fail(501, 'Reading bills is not set up on this server (no OPENAI_API_KEY).');
  const pages = images.filter((i) => typeof i === 'string' && i.startsWith('data:image/'));
  if (!pages.length) throw fail(400, 'There are no photos to read.');
  if (pages.length > 8) throw fail(400, 'Up to 8 pages can be read at once.');
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
