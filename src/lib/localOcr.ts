// Reading a bill on Tracklab's own server, free: Tesseract (tesseract.js,
// English data from @tesseract.js-data/eng, nothing downloaded) turns the
// photo into text, and parseBillText picks the fields out of that text.
//
// It is the reader of last resort (./billOcr): always there, no account, no
// key, and the photos never leave the server. It reads printed text well and
// handwriting or a crumpled slip poorly, and it doesn't read the lines of an
// invoice, only its header and totals. One read at a time (a worker uses a
// few hundred MB), each worker closed when done.

import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import sharp from 'sharp';

const requireHere = createRequire(import.meta.url);

/** Tesseract's text for each page (data: URLs), pages joined by a blank line. */
export async function recogniseText(pages: string[]): Promise<string> {
  return queue(async () => {
    const { createWorker } = await import('tesseract.js');
    const langPath = path.join(path.dirname(requireHere.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');
    const worker = await createWorker('eng', 1, { langPath, cachePath: os.tmpdir(), gzip: true, logger: () => {} } as any);
    try {
      const out: string[] = [];
      for (const p of pages) {
        const buf = Buffer.from(p.slice(p.indexOf(',') + 1), 'base64');
        const { data } = await worker.recognize(await prepare(buf));
        out.push(data.text || '');
      }
      return out.join('\n\n');
    } finally {
      await worker.terminate().catch(() => {});
    }
  });
}

/**
 * A phone photo made easier to read: turned upright, grey, enlarged to 3000 px
 * wide (Tesseract reads small print far better large), contrast stretched,
 * sharpened. Tried against real invoices: VAT numbers, dates and totals that
 * the raw photo lost came back.
 */
export async function prepare(buf: Buffer): Promise<Buffer> {
  try {
    return await sharp(buf).rotate().greyscale().resize({ width: 3000 }).normalise().sharpen({ sigma: 1.2 }).png().toBuffer();
  } catch {
    return buf; // not an image sharp knows: let Tesseract try it as it is
  }
}

// One at a time: a second read waits for the first.
let tail: Promise<unknown> = Promise.resolve();
function queue<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.catch(() => {});
  return run;
}

// ---------------------------------------------------------------------------
// Picking the fields out of the text (unit-tested).

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number) => String(n).padStart(2, '0');
const validDate = (y: number, m: number, d: number) => {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 ? `${y}-${pad(m)}-${pad(d)}` : null;
};

/** The first date in a piece of text, as YYYY-MM-DD: 2026-11-18, 18/11/2026, 18-11-26, 18 Nov 2026, Nov 18, 2026. Day before month (South African order). */
export function findDate(s: string): string | null {
  let m: RegExpExecArray | null;
  const re = /(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})|(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})|(\d{1,2})[\s\-\/.]*([A-Za-z]{3,9})\.?,?[\s\-\/.]*(\d{2,4})|([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/g;
  while ((m = re.exec(s))) {
    const yy = (v: string) => (v.length === 2 ? 2000 + Number(v) : Number(v));
    let hit: string | null = null;
    if (m[1]) hit = validDate(Number(m[1]), Number(m[2]), Number(m[3]));
    else if (m[4]) hit = validDate(yy(m[6]), Number(m[5]), Number(m[4]));
    else if (m[7]) { const mon = MONTHS[m[8].slice(0, 4).toLowerCase()] ?? MONTHS[m[8].slice(0, 3).toLowerCase()]; if (mon) hit = validDate(yy(m[9]), mon, Number(m[7])); }
    else if (m[10]) { const mon = MONTHS[m[10].slice(0, 3).toLowerCase()]; if (mon) hit = validDate(Number(m[12]), mon, Number(m[11])); }
    if (hit) return hit;
  }
  return null;
}

/** The amounts on a line, as numbers: R 1 554.50, 1,554.50, 1554,50, 174.00. Only amounts with cents count (so quantities and codes don't). */
export function amountsIn(line: string): number[] {
  const out: number[] = [];
  const re = /-?\d{1,3}(?:[ , ]\d{3})*[.,]\d{2}(?!\d)|-?\d+[.,]\d{2}(?!\d)/g;
  for (const raw of line.match(re) ?? []) {
    let s = raw.replace(/[  ]/g, '');
    if (/,\d{2}$/.test(s) && !/\.\d/.test(s)) s = s.replace(/\./g, '').replace(/,(\d{2})$/, '.$1'); // 1554,50
    s = s.replace(/,/g, '');
    const n = Number(s);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}
const lastAmount = (line: string) => { const a = amountsIn(line); return a.length ? a[a.length - 1] : null; };

/** A label's value: on the same line after it, or (for a header table) the line below. */
function after(lines: string[], label: RegExp, value: RegExp): string | null {
  for (let i = 0; i < lines.length; i++) {
    const m = label.exec(lines[i]);
    if (!m) continue;
    const rest = lines[i].slice(m.index + m[0].length);
    const v = value.exec(rest) ?? (lines[i + 1] ? value.exec(lines[i + 1]) : null);
    if (v) return (v[1] ?? v[0]).trim();
  }
  return null;
}

/**
 * The bill's fields from its text, in the reader's shape (normaliseBillOcr
 * tidies them). What isn't clearly there is left null; lines aren't read.
 */
export function parseBillText(text: string): Record<string, unknown> {
  // "co,za" and "co .za" are a misread full stop in a web address.
  const tidy = text.replace(/\b(co|com|org|net|gov|ac)\s*[,.]\s*(za|uk|com)\b/gi, '$1.$2');
  const lines = tidy.split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const all = lines.join('\n');

  // South African VAT numbers are 10 digits starting with 4; the seller's comes first on the page.
  let vat: string | null = null;
  for (const l of lines) {
    if (!/\bvat\b|\btax\s*(reg|no|number)/i.test(l)) continue;
    const m = /(4(?:[ \-.]?\d){9})(?!\d)/.exec(l);
    if (m) { vat = m[1].replace(/\D/g, ''); break; }
  }

  const notDate = (v: string | null) => (v && !findDate(v) && !/^\d{1,2}[-\/]\w{3}/.test(v) ? v : null);
  const invoiceNumber = notDate(after(lines, /\b(?:tax\s+)?invoice\s*(?:no\.?|number|num|#)\s*[:#.]?|\binv(?:oice)?\.?\s*(?:no\.?|#)\s*[:#.]?|\bdocument\s*(?:no\.?|number)\s*[:#.]?/i, /^\s*[:#]?\s*([A-Z]{0,5}[-\/]?\d[\w\-\/]{1,24})/i)
    ?? after(lines, /\binvoice\s*#?/i, /^\s*[:#]?\s*([A-Z]{0,5}[-\/]?\d[\w\-\/]{2,24})/i));
  // "PO" only as a word of its own ("POL MALE" on a product line isn't one); "order" only with no / number / #.
  const poNumber = after(lines, /\b(?:p\.?\s?o\b\.?\s*(?:no\.?|number|#)?|purchase\s+order\s*(?:no\.?|number|#)?|order\s*(?:no\.?|number|#))\s*[:#.]?|\byour\s+ref(?:erence)?\b\.?\s*[:#.]?|\bcustomer\s+ref(?:erence)?\b\.?\s*[:#.]?/i, /^\s*[:#]?\s*([A-Z]{0,5}[-\/]?\d[\w\-\/]{1,24})/i);

  const dateLine = (re: RegExp, skip?: RegExp) => {
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i]) || (skip && skip.test(lines[i]))) continue;
      const d = findDate(lines[i].replace(re, ' ')) ?? (lines[i + 1] ? findDate(lines[i + 1]) : null);
      if (d) return d;
    }
    return null;
  };
  const DUE = /\b(?:due\s*date|payment\s*due|due\s*by|due)\b/i;
  const dueDate = dateLine(DUE);
  const date = dateLine(/\b(?:invoice\s*date|tax\s*invoice\s*date|date\s*of\s*issue|doc(?:ument)?\s*date|date)\b/i, DUE)
    ?? lines.map(l => (DUE.test(l) ? null : findDate(l))).find(Boolean) ?? null;

  // Each total is the amount after its label on the line (a line can carry other numbers before it).
  let subtotal: number | null = null, taxTotal: number | null = null, total: number | null = null;
  const amountAfter = (l: string, re: RegExp) => { const m = re.exec(l); return m ? lastAmount(l.slice(m.index + m[0].length)) : null; };
  for (const l of lines) {
    if (lastAmount(l) === null) continue;
    const sub = amountAfter(l, /\b(sub\s*-?\s*total|total\s*(?:excl|ex|before|nett?)\.?|nett?\s*total|amount\s*excl)/i);
    if (sub !== null) { subtotal = sub; continue; }
    const tax = amountAfter(l, /\b(vat|tax)\b(?!\s*(?:reg|no\b|number|#|incl|able))(?:\s*\(?\d{1,2}\s*%\)?)?/i);
    if (tax !== null && !/\btotal\s*(incl|due)/i.test(l)) { taxTotal = tax; continue; }
    if (/\b(qty|items|quantity|paid|balance|change|tendered|round)\b/i.test(l)) continue;
    const tot = amountAfter(l, /\b(grand\s*total|total\s*(?:incl\w*|due|amount|payable)?|amount\s*due)\b/i);
    if (tot !== null) total = tot;
  }

  // A misread address ("communica €o.2a") is left out rather than kept wrong: the domain must end in letters.
  const email = /[\w.+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/i.exec(all)?.[0]?.toLowerCase() ?? null;
  const website = /\b(?:https?:\/\/\s*)?(www\.[a-z0-9-]+(?:\.[a-z]{2,})+)\b/i.exec(all)?.[1]?.toLowerCase() ?? null;
  const phoneLine = lines.find(l => /\b(tel|phone|cell|mobile|ph|fax)\b/i.test(l) && /\d{3}/.test(l) && !/\bfax\b/i.test(l)) ?? lines.find(l => /(?:\+27|\b0)\s?\d{2}[\s-]?\d{3}[\s-]?\d{4}\b/.test(l));
  const phone = phoneLine ? (/((?:\+27|\(?0)\s?\(?\d{2}\)?[\s-]?\d{3}[\s-]?\d{4})/.exec(phoneLine)?.[1] ?? null) : null;

  // The supplier: a company name with its suffix ("Communica (Pty) Ltd", "HDCabling CC") first;
  // else the first line near the top that reads like a name.
  const COMPANY = /([A-Z][A-Za-z0-9&'.\- ]{1,40}?)\s*(\(Pty\)\s*Ltd|Pty\.?\s*Ltd|\(Pty\)|Ltd|Limited|\bCC|Inc)\b\.?/;
  const company = lines.filter(l => !/\b(customer|bill(?:ing)?\s*(to|address)|deliver(?:y)?\s*(to|address)|ship\s*to|sold\s*to)\b/i.test(l))
    .map(l => COMPANY.exec(l.replace(/^.*?\b(?:acc(?:ount)?\s*holder|account\s*name|company|from)\s*[:\-]\s*/i, '')))
    .find(m => m && m[1].replace(/[^A-Za-z]/g, '').length >= 3);
  const supplier = (company ? `${company[1].trim()} ${company[2].replace(/\s+/g, ' ')}`.trim() : null) ?? lines.slice(0, 8).find(l => {
    const letters = l.replace(/[^A-Za-z]/g, '').length;
    return letters >= 3 && letters / l.length > 0.6 && l.length <= 60
      && !/\b(tax\s+invoice|invoice|receipt|statement|quotation|delivery|page|date|tel|phone|vat|reg|bill\s*to|ship\s*to|customer|account)\b/i.test(l);
  }) ?? null;

  const currency = /\bZAR\b|\bR\s?\d/.test(all) ? 'ZAR' : /\bUSD\b|\$\s?\d/.test(all) ? 'USD' : /\bEUR\b|€/.test(all) ? 'EUR' : /\bGBP\b|£/.test(all) ? 'GBP' : null;

  return {
    supplier, supplierVatNumber: vat, supplierAddress: null, supplierPhone: phone, supplierEmail: email, supplierWebsite: website,
    invoiceNumber, date, dueDate, poNumber, currency, subtotal, taxTotal, total, lineItems: [], text,
  };
}
