// Shared PDF-doc builder used by every bookkeeping viewer that offers a
// "Save PDF" download (sales orders, quotations, invoices, bills,
// delivery notes, collection notes). Builds the PDF straight from the
// entity object with jsPDF + jspdf-autotable — no HTML→canvas path,
// which we tried three ways and could never coax past blank output.
//
// Callers pass a normalised shape (docType, docNumber, meta pairs,
// line items, totals, notes). The helper draws the TRACKLAB brand
// header, a two-column meta grid, an autoTable of lines, a totals
// block, an optional notes paragraph, and a generated-on footer. Money
// figures flow through the SANS 24 formatter so every doc matches the
// on-screen totals byte-for-byte.

import { fmtCurrency } from './formatMoney';

// A meta pair — left-aligned label above value, laid out two per row.
// null skips the slot so we can keep alignment when a field is empty.
export type MetaPair = { label: string; value: string } | null;

// A line row. Keep it flexible: dispatch notes have no unit price /
// total, invoices/bills/SOs do. The columns adjust based on which
// numeric fields the caller supplies.
export interface DocLine {
  partNumber?: string;
  description: string;
  quantity: number | string;
  unitPrice?: number | null;
  lineTotal?: number | null;
  extra?: string; // serial numbers for dispatch notes, etc.
}

export interface DocTotals {
  subtotal?: number;
  tax?: number;
  discount?: number;
  total: number;
  amountPaid?: number;
  balanceDue?: number;
}

export interface BuildDocPdfInput {
  docType: string;          // "Sales Order", "Invoice", "Bill", "Delivery Note", …
  docNumber: string;        // "INV-2026-0007", "QUO-2026-0002", …
  meta: MetaPair[];         // meta pairs, laid out 2 per row
  lines: DocLine[];
  totals?: DocTotals;       // omit for docs like dispatch notes with no money
  notes?: string;
  currency?: string;        // ZAR, USD… routed to fmtCurrency
  extraColumnHeader?: string; // e.g. "Serial numbers" for dispatch
  /** Image data URLs (scanned receipt pages, …) appended one per page after the document. */
  attachments?: string[];
  attachmentsLabel?: string; // heading on each attachment page, default "Attachment"
  /** File name to save as (without .pdf); default "<doc-type>-<number>". */
  fileName?: string;
}

/** "BILL-2026-0009" + "ACDC Express" → "BILL-2026-0009_ACDC_EXPRESS": safe on every OS, readable in a folder. */
export function docFileName(docNumber: string, party?: string | null): string {
  const clean = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/&/g, ' AND ').replace(/[^A-Z0-9-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  const p = party ? clean(party).slice(0, 60).replace(/_$/, '') : '';
  return [clean(docNumber) || 'DOCUMENT', p].filter(Boolean).join('_');
}

/** Largest size that fits w×h inside boxW×boxH without stretching (never upscales past the box). */
export function fitInto(w: number, h: number, boxW: number, boxH: number): { w: number; h: number } {
  if (!(w > 0) || !(h > 0)) return { w: boxW, h: boxH };
  const s = Math.min(boxW / w, boxH / h);
  return { w: w * s, h: h * s };
}

/** Re-encode any browser-readable image as JPEG (jsPDF reads every format that way, and big phone photos shrink). */
async function toJpeg(dataUrl: string): Promise<{ data: string; w: number; h: number }> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const maxSide = 2400; // plenty for an A4 page at print resolution
  const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * s));
  const h = Math.max(1, Math.round(img.naturalHeight * s));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff'; // transparent PNGs would otherwise turn black
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return { data: canvas.toDataURL('image/jpeg', 0.85), w, h };
}

/** jsPDF + autotable, loaded on demand (a stale tab reloads once to pick up the new chunks). */
export async function loadPdfLib(): Promise<{ jsPDF: any; autoTable: any }> {
  // Wrap the dynamic imports so a stale-chunk error (old tab holding
  // a bundle whose jspdf chunk hash no longer exists on the server
  // after a redeploy) surfaces as a clear reload prompt instead of the
  // opaque "Failed to fetch dynamically imported module" message.
  let jsPDF: any, autoTableMod: any;
  try {
    [{ default: jsPDF }, autoTableMod] = await Promise.all([
      import('jspdf'),
      import('jspdf-autotable'),
    ]);
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (/dynamically imported module|Loading chunk|Failed to fetch/i.test(msg)) {
      // Auto-reload once. Guarded by sessionStorage so we don't loop if
      // the server genuinely can't serve the chunk.
      const key = 'pdf-chunk-reload-attempted';
      if (!sessionStorage.getItem(key)) {
        sessionStorage.setItem(key, '1');
        alert('This tab is running an older version of the app. Reloading to pick up the latest build.');
        location.reload();
        throw new Error('Reloading to fetch latest build');
      }
      throw new Error('Could not load the PDF library. Refresh the page (Ctrl+Shift+R / Cmd+Shift+R) and try again.');
    }
    throw err;
  }
  return { jsPDF, autoTable: autoTableMod.default || autoTableMod };
}

export async function buildAndSaveDocPdf(input: BuildDocPdfInput): Promise<string> {
  const { jsPDF, autoTable } = await loadPdfLib();

  const currency = input.currency || 'ZAR';
  const money = (n: any) => fmtCurrency(Number(n) || 0, currency);

  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const M = 15;

  // ── Brand header ──────────────────────────────────────────────────
  doc.setTextColor(247, 145, 43);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(26);
  doc.text('TRACKLAB', M, 22);
  doc.setFontSize(9);
  doc.setTextColor(120, 120, 120);
  doc.text('INVENTORY · MANUFACTURING · COMPLIANCE', M, 28);

  // Doc-type + number, right-aligned.
  doc.setTextColor(0, 0, 0);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.text(input.docType, pageWidth - M, 22, { align: 'right' });
  doc.setFont('courier', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(247, 145, 43);
  doc.text(String(input.docNumber || ''), pageWidth - M, 28, { align: 'right' });

  // Orange rule under the header.
  doc.setDrawColor(247, 145, 43);
  doc.setLineWidth(0.8);
  doc.line(M, 32, pageWidth - M, 32);

  // ── Meta grid: 2 columns × N rows ─────────────────────────────────
  const metaTop = 40;
  const rowH = 6;
  const drawLabel = (text: string, x: number, y: number) => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text(text, x, y);
  };
  const drawVal = (text: string, x: number, y: number) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(0);
    doc.text(text || '—', x, y);
  };
  let metaCursor = metaTop;
  for (let i = 0; i < input.meta.length; i += 2) {
    const left = input.meta[i];
    const right = input.meta[i + 1] || null;
    if (left) {
      drawLabel(left.label.toUpperCase(), M, metaCursor);
      drawVal(String(left.value ?? ''), M, metaCursor + rowH);
    }
    if (right) {
      drawLabel(right.label.toUpperCase(), pageWidth / 2, metaCursor);
      drawVal(String(right.value ?? ''), pageWidth / 2, metaCursor + rowH);
    }
    metaCursor += rowH * 2.5;
  }

  // ── Line-items table ──────────────────────────────────────────────
  const hasMoney = input.lines.some(l => l.unitPrice != null || l.lineTotal != null);
  const hasExtra = !!input.extraColumnHeader && input.lines.some(l => l.extra);

  const head: string[] = ['Description', 'Qty'];
  if (hasMoney) { head.push('Unit Price', 'Total'); }
  if (hasExtra) { head.push(input.extraColumnHeader!); }

  const body = input.lines.length > 0
    ? input.lines.map(l => {
        const row: string[] = [
          `${l.partNumber ? `${l.partNumber}  ` : ''}${l.description || ''}`,
          String(l.quantity ?? ''),
        ];
        if (hasMoney) {
          row.push(l.unitPrice != null ? money(l.unitPrice) : '');
          row.push(l.lineTotal != null ? money(l.lineTotal) : '');
        }
        if (hasExtra) row.push(l.extra || '');
        return row;
      })
    : [Array(head.length).fill('').map((_, i) => i === 0 ? 'No line items' : '')];

  const colStyles: any = { 0: { cellWidth: 'auto' }, 1: { halign: 'right', cellWidth: 20 } };
  if (hasMoney) {
    colStyles[2] = { halign: 'right', cellWidth: 30 };
    colStyles[3] = { halign: 'right', cellWidth: 30, fontStyle: 'bold' };
  }
  if (hasExtra) {
    colStyles[head.length - 1] = { cellWidth: 40, fontSize: 8 };
  }

  autoTable(doc, {
    startY: metaCursor + 2,
    head: [head],
    body,
    styles: { fontSize: 9, cellPadding: 2.5, textColor: 20 },
    headStyles: { fillColor: [30, 30, 30], textColor: 255, fontStyle: 'bold', fontSize: 8 },
    columnStyles: colStyles,
    margin: { left: M, right: M },
    theme: 'grid',
  });

  const finalY = (doc as any).lastAutoTable?.finalY || metaCursor + 60;

  // ── Totals block (right-aligned) ─────────────────────────────────
  let ty = finalY + 8;
  if (input.totals) {
    const totalsX = pageWidth - M - 60;
    const totalsW = 60;
    const line = (label: string, val: string, strong = false, colour?: [number, number, number]) => {
      doc.setFont('helvetica', strong ? 'bold' : 'normal');
      doc.setFontSize(strong ? 12 : 10);
      const c = colour || (strong ? [247, 145, 43] : [60, 60, 60]);
      doc.setTextColor(c[0], c[1], c[2]);
      doc.text(label, totalsX, ty);
      doc.text(val, totalsX + totalsW, ty, { align: 'right' });
      ty += strong ? 8 : 6;
    };
    const t = input.totals;
    if (t.subtotal != null) line('Subtotal', money(t.subtotal));
    if (t.discount != null && t.discount !== 0) line('Discount', `-${money(t.discount)}`);
    if (t.tax != null) line('Tax', money(t.tax));
    // Rule sits just under the line above, then the Total drops below it
    // (it used to be drawn through the Total text).
    doc.setDrawColor(180);
    doc.setLineWidth(0.3);
    doc.line(totalsX, ty - 3.5, totalsX + totalsW, ty - 3.5);
    ty += 2;
    line('Total', money(t.total), true);
    if (t.amountPaid != null && t.amountPaid !== 0) line('Amount paid', money(t.amountPaid), false, [22, 163, 74]);
    if (t.balanceDue != null && t.balanceDue !== 0) line('Balance due', money(t.balanceDue), true, [239, 68, 68]);
  }

  // ── Notes block ──────────────────────────────────────────────────
  if (input.notes) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(9);
    doc.setTextColor(80);
    doc.text('Notes:', M, ty + 8);
    const noteLines = doc.splitTextToSize(String(input.notes), pageWidth - M * 2);
    doc.text(noteLines, M, ty + 13);
  }

  const pageH = doc.internal.pageSize.getHeight();

  // ── Attachments: one image per extra page ────────────────────────
  const attachments = (input.attachments || []).filter(a => /^data:image\//i.test(a));
  let skipped = 0;
  for (let i = 0; i < attachments.length; i++) {
    let jpeg: { data: string; w: number; h: number };
    try { jpeg = await toJpeg(attachments[i]); } catch { skipped++; continue; }
    doc.addPage();
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(247, 145, 43);
    const label = input.attachmentsLabel || 'Attachment';
    doc.text(attachments.length > 1 ? `${label} · page ${i + 1} of ${attachments.length}` : label, M, 14);
    doc.setFont('courier', 'normal');
    doc.setTextColor(120);
    doc.text(String(input.docNumber || ''), pageWidth - M, 14, { align: 'right' });
    const top = 19, bottom = pageH - 14;
    const fit = fitInto(jpeg.w, jpeg.h, pageWidth - M * 2, bottom - top);
    doc.addImage(jpeg.data, 'JPEG', (pageWidth - fit.w) / 2, top, fit.w, fit.h);
  }
  if (skipped) console.warn(`PDF: ${skipped} attachment(s) could not be read and were left out`);

  // ── Footer on every page ─────────────────────────────────────────
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(160);
    doc.text(
      `TRACKLAB IM · Generated ${new Date().toLocaleString()}${pages > 1 ? ` · Page ${p} of ${pages}` : ''}`,
      pageWidth / 2, pageH - 8,
      { align: 'center' },
    );
  }

  // Kebab-case doc type for the filename so a delivery note becomes
  // "delivery-note-DN-2026-0004.pdf".
  const slug = input.docType.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const filename = input.fileName ? `${input.fileName}.pdf` : `${slug}-${input.docNumber}.pdf`;
  doc.save(filename);
  return filename;
}
