// Client-side wrapper over the server's OpenAI Vision OCR endpoint
// (POST /api/bookkeeping/ocr/receipt). Same OcrResult shape the
// scan modal + bill editor were already consuming so this drop-in
// replaces the local Tesseract implementation without any downstream
// changes.
//
// One or more base64 data URLs go up; a structured result comes back
// with the supplier, date, total, tax, currency, line items, and the
// concatenated readable text. If the server 501s (no OPENAI_API_KEY
// set), we throw a descriptive error the scan modal already knows
// how to fall back on (image saved without OCR, INFO toast).

export interface OcrLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface OcrResult {
  text: string;
  supplier: string | null;
  date: string | null;      // ISO YYYY-MM-DD when the model could parse one
  total: number | null;     // grand total the customer owes
  taxTotal?: number | null; // new: VAT / GST amount when stated
  currency?: string | null; // new: ISO currency code when the model could infer one
  lineItems: OcrLineItem[];
}

// runOcr accepts either a single data URL (backwards-compat with the
// old signature that the scan modal calls with one image at a time)
// or an array of them (multi-page receipts / an invoice + a POP).
export async function runOcr(input: string | string[]): Promise<OcrResult> {
  const images = Array.isArray(input) ? input : [input];
  const clean = images.filter(i => typeof i === 'string' && i.startsWith('data:image/'));
  if (clean.length === 0) throw new Error('OCR needs at least one data:image/… URL');

  const res = await fetch('/api/bookkeeping/ocr/receipt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ images: clean }),
  });
  if (!res.ok) {
    // 501 → server has no OPENAI_API_KEY; caller displays a friendly
    // "OCR unavailable" toast and keeps the raw image save flow.
    let msg = 'OCR request failed';
    try { const body = await res.json(); msg = body?.error || msg; } catch { /* leave default */ }
    throw new Error(msg);
  }
  const data = await res.json();
  return {
    text: String(data?.text || ''),
    supplier: (data?.supplier ?? null) || null,
    date: (data?.date ?? null) || null,
    total: typeof data?.total === 'number' ? data.total : null,
    taxTotal: typeof data?.taxTotal === 'number' ? data.taxTotal : null,
    currency: (data?.currency ?? null) || null,
    lineItems: Array.isArray(data?.lineItems)
      ? data.lineItems.map((li: any) => ({
          description: String(li?.description || ''),
          quantity: Number(li?.quantity) || 1,
          unitPrice: Number(li?.unitPrice) || 0,
          lineTotal: Number(li?.lineTotal) || 0,
        }))
      : [],
  };
}
