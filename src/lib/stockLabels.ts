// Bin and item labels, and reading what a scanner types back.
//
// A bin label's barcode is "LOC:" + the location code; an item label's is the
// stock code as it is. The prefix tells a bin from an item even when the bin
// is named after the item it holds (bin ANT-001 holds ANT-001).

import { code128Svg } from './code128';

export const BIN_PREFIX = 'LOC:';

export interface Label { code: string; title?: string | null; kind: 'bin' | 'item' }

export type Scanned = { kind: 'bin'; code: string } | { kind: 'code'; code: string } | null;

/** What a scan (or a typed code) is: a bin, when it has the bin prefix; otherwise a code to look up. */
export function readScan(text: string): Scanned {
  const t = String(text ?? '').trim();
  if (!t) return null;
  if (t.toUpperCase().startsWith(BIN_PREFIX)) {
    const code = t.slice(BIN_PREFIX.length).trim().toUpperCase();
    return code ? { kind: 'bin', code } : null;
  }
  return { kind: 'code', code: t };
}

/** What a label's barcode holds. */
export const labelPayload = (l: Label) => (l.kind === 'bin' ? `${BIN_PREFIX}${l.code}` : l.code);

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);

/**
 * A printable page of labels: A4, 3 across by 7 down (63.5 × 38.1 mm, the
 * common 21-to-a-sheet label size), each with the code, its name and the barcode.
 */
export function labelsHtml(labels: Label[]): string {
  const cells = labels.map((l) => `<div class="label">
      <div class="kind">${l.kind === 'bin' ? 'BIN' : 'ITEM'}</div>
      <div class="code">${esc(l.code)}</div>
      <div class="title">${esc(l.title ?? '')}</div>
      <div class="bars">${code128Svg(labelPayload(l))}</div>
    </div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Labels (${labels.length})</title>
<style>
  @page { size: A4; margin: 15.1mm 7.2mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #000; }
  .sheet { display: grid; grid-template-columns: repeat(3, 63.5mm); grid-auto-rows: 38.1mm; column-gap: 2.5mm; }
  .label { padding: 2.5mm 3mm; overflow: hidden; display: flex; flex-direction: column; break-inside: avoid; position: relative; }
  .kind { position: absolute; top: 2.5mm; right: 3mm; font-size: 7pt; color: #555; letter-spacing: .5px; }
  .code { font-family: "Courier New", monospace; font-weight: bold; font-size: 14pt; line-height: 1.1; padding-right: 9mm; word-break: break-all; }
  .title { font-size: 7.5pt; line-height: 1.15; height: 2.3em; overflow: hidden; margin-top: .5mm; }
  .bars { margin-top: auto; height: 13mm; }
  .bars svg { width: 100%; height: 100%; display: block; }
  @media screen { body { background: #eee; padding: 10mm; } .sheet { background: #fff; width: max-content; } .label { outline: 1px dashed #ccc; } }
</style></head><body><div class="sheet">${cells}</div></body></html>`;
}

/** Opens the labels in a new window and prints them (the same way invoices print). */
export function printLabels(labels: Label[]): boolean {
  const w = window.open('', '_blank', 'width=900,height=1000');
  if (!w) return false;
  w.document.open();
  w.document.write(labelsHtml(labels));
  w.document.close();
  w.focus();
  w.print();
  return true;
}
