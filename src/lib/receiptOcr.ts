// Lightweight, heuristic OCR post-processing for scanned till slips and vendor
// invoices. Tesseract itself is loaded on demand — the WASM engine is ~10MB, so
// we don't want it in the initial bundle. The `runOcr` helper does the dynamic
// import lazily and reuses a worker for subsequent calls in the same session.

export interface OcrResult {
  text: string;
  supplier: string | null;
  date: string | null;   // ISO YYYY-MM-DD when we could parse one
  total: number | null;  // in the currency of the receipt, unit unspecified
}

let workerPromise: Promise<any> | null = null;

async function getWorker(): Promise<any> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import('tesseract.js');
      // English is enough for local receipts — swap for a language pack per
      // installation later if needed.
      const worker = await createWorker('eng');
      return worker;
    })();
  }
  return workerPromise;
}

export async function runOcr(dataUrl: string): Promise<OcrResult> {
  const worker = await getWorker();
  const { data } = await worker.recognize(dataUrl);
  const text: string = String(data?.text || '');
  return {
    text,
    supplier: extractSupplier(text),
    date: extractDate(text),
    total: extractTotal(text),
  };
}

// The vendor name is almost always in the first non-empty line of the slip —
// or split across the first two if the trading name is long. Ignore lines that
// are obviously headers ("TAX INVOICE", "RECEIPT"), phone numbers, or VAT
// numbers. Return null if nothing looks name-y.
// Exported for unit tests — real callers use `runOcr` above.
export function extractSupplier(text: string): string | null {
  const junk = /^\s*(tax\s+invoice|invoice|receipt|vat\s+no|vat\s*#|reg\s*no|customer|receipt\s*#|no\.|no|slip)\s*[:#-]?/i;
  const phony = /^[\d\s\-().+]{5,}$/;
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines.slice(0, 6)) {
    if (junk.test(line)) continue;
    if (phony.test(line)) continue;
    if (line.length < 3 || line.length > 60) continue;
    // Prefer a line with letters — receipts often start with an ASCII logo.
    if (/[A-Za-z]/.test(line)) return line;
  }
  return null;
}

// Accept common receipt-visible date formats and normalise to ISO YYYY-MM-DD.
// Years two digits wide are pinned to 2000-2099.
export function extractDate(text: string): string | null {
  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/;
  const dmy = /(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/;
  const written = /(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+(\d{2,4})/i;

  const pad = (n: number) => String(n).padStart(2, '0');
  const clampYear = (y: number) => (y < 100 ? 2000 + y : y);

  let m: RegExpMatchArray | null;
  if ((m = text.match(iso))) {
    const [_, y, mo, d] = m;
    return `${y}-${pad(+mo)}-${pad(+d)}`;
  }
  if ((m = text.match(written))) {
    const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const monthIndex = months.indexOf(m[2].toLowerCase().slice(0, 3));
    if (monthIndex >= 0) return `${clampYear(+m[3])}-${pad(monthIndex + 1)}-${pad(+m[1])}`;
  }
  if ((m = text.match(dmy))) {
    // Ambiguous — but ZA receipts are DD/MM/YYYY overwhelmingly.
    const day = +m[1], month = +m[2], year = clampYear(+m[3]);
    if (day <= 31 && month <= 12) return `${year}-${pad(month)}-${pad(day)}`;
  }
  return null;
}

// Look for a "TOTAL" line first (with variants); if that fails, take the
// largest money-shaped number on the receipt. Handles a few OCR quirks
// (comma decimals from ZA locale, currency prefixes like R / ZAR / $).
export function extractTotal(text: string): number | null {
  // Currency prefix is OPTIONAL — some slips omit the R/$. Wrapping in a
  // non-capturing group + ? makes the whole prefix optional (was only
  // making the trailing whitespace lazy before, which required a prefix).
  const money = /(?:(?:R|ZAR|\$|£|€)\s*)?(-?\d{1,7}(?:[,\s]\d{3})*(?:[.,]\d{2}))/gi;
  const parseMoney = (raw: string): number => {
    const cleaned = raw.replace(/\s/g, '').replace(/,(?=\d{3})/g, '');
    return parseFloat(cleaned.replace(',', '.'));
  };
  const lines = text.split(/\r?\n/);

  // Named-total pass: look for TOTAL / GRAND TOTAL / AMOUNT DUE / BALANCE.
  // Word-boundary before "total" so Sub<b>total</b> doesn't hijack the read.
  const totalKeywords = /(grand\s+total|amount\s+(due|owing)|balance\s+due|balance\s+owing|\btotal(?!\s+(vat|excl))|invoice\s+total)/i;
  for (const line of lines) {
    if (!totalKeywords.test(line)) continue;
    // Reset regex state — /g regexes carry lastIndex across matchAll calls.
    money.lastIndex = 0;
    const matches = Array.from(line.matchAll(money));
    if (matches.length) {
      const last = matches[matches.length - 1][1];
      const val = parseMoney(last);
      if (Number.isFinite(val) && val > 0) return val;
    }
  }

  // Fallback: largest money-shaped number on the receipt.
  money.lastIndex = 0;
  let max = 0;
  for (const m of text.matchAll(money)) {
    const val = parseMoney(m[1]);
    if (Number.isFinite(val) && val > max) max = val;
  }
  return max > 0 ? max : null;
}
