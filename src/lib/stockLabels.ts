// Bin and item labels, and reading what a scanner types back.
//
// A bin label's barcode is "LOC:" + the location code; an item label's is the
// stock code as it is. The prefix tells a bin from an item even when the bin
// is named after the item it holds (bin ANT-001 holds ANT-001).
// A reel label is a QR code holding the stock code with the reel's lot, date
// code, quantity and place (./reelLabel), so one scan fills them all in.

import { code128Svg } from './code128';
import { BIN_PREFIX, readReel, reelPayload } from './reelLabel';

export { BIN_PREFIX };

export interface Label {
  code: string; title?: string | null; kind: 'bin' | 'item' | 'unit' | 'batch' | 'reel';
  /** A reel label's details, all optional. */
  lot?: string | null; dateCode?: string | null; qty?: number | null; place?: string | null;
}
const KIND: Record<Label['kind'], string> = { bin: 'BIN', item: 'ITEM', unit: 'UNIT', batch: 'BATCH', reel: 'REEL' };

export type Scanned = { kind: 'bin'; code: string } | { kind: 'code'; code: string } | null;

/** What a scan (or a typed code) is: a bin, when it has the bin prefix; otherwise a code to look up. */
export function readScan(text: string): Scanned {
  const t = String(text ?? '').trim();
  if (!t) return null;
  if (t.toUpperCase().startsWith(BIN_PREFIX)) {
    const code = t.slice(BIN_PREFIX.length).trim().toUpperCase();
    return code ? { kind: 'bin', code } : null;
  }
  // A reel label: the item is its stock code.
  const reel = readReel(t);
  if (reel) return { kind: 'code', code: reel.code };
  return { kind: 'code', code: t };
}

/** What a label's barcode holds. */
export const labelPayload = (l: Label) =>
  l.kind === 'bin' ? `${BIN_PREFIX}${l.code}` : l.kind === 'reel' ? reelPayload({ code: l.code, lot: l.lot, dateCode: l.dateCode, qty: l.qty, place: l.place }) : l.code;

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);

/**
 * A printable page of labels: A4, 3 across by 7 down (63.5 × 38.1 mm, the
 * common 21-to-a-sheet label size), each with the code, its name and the
 * barcode. Reel labels carry a QR code instead, drawn by `qr` (./qrSvg,
 * loaded only when reels are printed).
 */
export function labelsHtml(labels: Label[], qr?: (text: string) => string): string {
  const cells = labels.map((l) => l.kind === 'reel' && qr ? `<div class="label reel">
      <div class="qr">${qr(labelPayload(l))}</div>
      <div class="info">
        <div class="code">${esc(l.code)}</div>
        <div class="title">${esc(l.title ?? '')}</div>
        <div class="facts">${[l.lot && `Lot <b>${esc(l.lot)}</b>`, l.dateCode && `D/C <b>${esc(l.dateCode)}</b>`, l.qty && `Qty <b>${esc(l.qty)}</b>`, l.place && `At <b>${esc(l.place)}</b>`].filter(Boolean).join('<br>')}</div>
      </div>
    </div>` : `<div class="label">
      <div class="kind">${KIND[l.kind]}</div>
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
  .reel { flex-direction: row; gap: 2.5mm; align-items: center; }
  .reel .qr { width: 30mm; height: 30mm; flex: none; }
  .reel .qr svg { width: 100%; height: 100%; display: block; }
  .reel .info { min-width: 0; flex: 1; align-self: stretch; display: flex; flex-direction: column; }
  .reel .code { font-size: 11pt; padding-right: 0; }
  .reel .title { height: 3.45em; }
  .reel .facts { font-size: 7.5pt; line-height: 1.3; margin-top: auto; }
  @media screen { body { background: #eee; padding: 10mm; } .sheet { background: #fff; width: max-content; } .label { outline: 1px dashed #ccc; } }
</style></head><body><div class="sheet">${cells}</div></body></html>`;
}

/**
 * Opens the labels in a new window and prints them (the same way invoices
 * print). The window opens straight away, so the browser counts it as the
 * click's; reel labels are drawn once the QR encoder has loaded.
 */
export function printLabels(labels: Label[]): boolean {
  const w = window.open('', '_blank', 'width=900,height=1000');
  if (!w) return false;
  const show = (html: string) => { w.document.open(); w.document.write(html); w.document.close(); w.focus(); w.print(); };
  if (!labels.some((l) => l.kind === 'reel')) { show(labelsHtml(labels)); return true; }
  w.document.write('<p style="font-family:Arial,sans-serif">Preparing the labels…</p>');
  import('./qrSvg')
    .then(({ qrSvg }) => show(labelsHtml(labels, qrSvg)))
    .catch(() => { w.document.body.textContent = 'Could not draw the QR codes. Close this window and try again.'; });
  return true;
}
