// Customer statement PDF: one customer, or every customer (one after the
// other, each starting on a new page). Carries the customer's details,
// a summary, every transaction with a running balance (invoice lines and
// VAT, what each payment paid, credit-note lines), the aging matrix and
// the overdue invoices.

import { fmtCurrency } from './formatMoney';
import { loadPdfLib } from './pdfDocs';
import type { CustomerStatement, StatementTxn } from './customerStatement';

const money = (n: number) => fmtCurrency(Number(n) || 0, 'ZAR');
const TYPE_LABEL: Record<StatementTxn['type'], string> = { INVOICE: 'Invoice', PAYMENT: 'Payment', CREDIT_NOTE: 'Credit note', REFUND: 'Refund' };

export type StatementRow = { cells: string[]; detail?: boolean };

/** The transactions table: one row per document, with its details under it. */
export function statementRows(s: CustomerStatement): StatementRow[] {
  const rows: StatementRow[] = [{ cells: [s.period.from ?? '', '', 'Opening balance', '', '', '', money(s.openingBalance)] }];
  // Detail rows span Details..Credit in the PDF, so any amount goes in the text, not under Debit.
  const detail = (text: string, amount = ''): StatementRow => ({ cells: ['', '', amount ? `${text}: ${amount}` : text, '', '', '', ''], detail: true });
  for (const t of s.transactions) {
    const details = [TYPE_LABEL[t.type], t.type === 'INVOICE' && t.status ? t.status : '', t.type === 'CREDIT_NOTE' ? t.description.replace(/^Credit note( · )?/, '') : '', t.reference ? `Ref ${t.reference}` : '', t.type === 'PAYMENT' ? t.description.replace(/^Payment( · )?/, '') : '']
      .filter(Boolean).join(' · ');
    rows.push({ cells: [t.date, t.docNumber, details, t.dueDate ?? '', t.debit ? money(t.debit) : '', t.credit ? money(t.credit) : '', money(t.runningBalance)] });
    for (const l of t.lines ?? []) {
      rows.push(detail(`${l.partNumber ? `${l.partNumber}  ` : ''}${l.description}  ·  ${l.quantity} × ${money(l.unitPrice)} = ${money(l.lineTotal)}`));
    }
    if (t.type === 'INVOICE') {
      if (t.discount) rows.push(detail('Discount', `-${money(t.discount)}`));
      if (t.subtotal != null && (t.lines?.length ?? 0) > 0) rows.push(detail('Subtotal', money(t.subtotal)));
      if (t.tax) rows.push(detail('VAT', money(t.tax)));
      if ((t.balanceDue ?? 0) > 0.005) rows.push(detail('Still owing on this invoice', money(t.balanceDue!)));
    }
    for (const a of t.appliedTo ?? []) rows.push(detail(`Paid towards ${a.docNumber}`, money(a.amount)));
    for (const n of t.notes ?? []) rows.push(detail(`Note: ${n}`));
  }
  rows.push({ cells: [s.period.asOf, '', 'Closing balance', '', '', '', money(s.closingBalance)] });
  return rows;
}

const slug = (s: string) => s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/(^-|-$)/g, '');

export function statementFilename(statements: CustomerStatement[], asOf: string): string {
  return statements.length === 1
    ? `customer-statement-${slug(statements[0].client.name)}-${asOf}.pdf`
    : `customer-statements-all-${asOf}.pdf`;
}

export async function saveStatementsPdf(statements: CustomerStatement[], asOf: string): Promise<string> {
  const { jsPDF, autoTable } = await loadPdfLib();
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  const W = doc.internal.pageSize.getWidth();
  const M = 15;

  statements.forEach((s, idx) => {
    if (idx > 0) doc.addPage();
    // Header
    doc.setTextColor(247, 145, 43); doc.setFont('helvetica', 'bold'); doc.setFontSize(26);
    doc.text('TRACKLAB', M, 22);
    doc.setFontSize(9); doc.setTextColor(120);
    doc.text('INVENTORY · MANUFACTURING · COMPLIANCE', M, 28);
    doc.setTextColor(0); doc.setFontSize(18);
    doc.text('Customer Statement', W - M, 22, { align: 'right' });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(80);
    doc.text(s.period.from ? `${s.period.from} to ${s.period.asOf}` : `As of ${s.period.asOf}`, W - M, 28, { align: 'right' });
    doc.setDrawColor(247, 145, 43); doc.setLineWidth(0.8); doc.line(M, 32, W - M, 32);

    // Customer block (left) and summary (right)
    let y = 40;
    doc.setFontSize(8); doc.setTextColor(120); doc.text('STATEMENT FOR', M, y);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(0);
    doc.text(s.client.name, M, y + 6);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(50);
    const who = [
      s.client.contactName ? `Attn: ${s.client.contactName}` : '',
      ...(s.client.address ? doc.splitTextToSize(s.client.address, W / 2 - M - 5) : []),
      s.client.email ?? '', s.client.phone ?? '',
      s.client.vatNumber ? `VAT no. ${s.client.vatNumber}` : '',
      s.client.paymentTermsDays != null ? `Terms: ${s.client.paymentTermsDays} days` : '',
    ].filter(Boolean);
    who.forEach((line, i) => doc.text(line, M, y + 12 + i * 4.5));
    const leftBottom = y + 12 + who.length * 4.5;

    const sx = W / 2 + 5, sw = W - M - sx;
    const summary: Array<[string, number]> = [
      ['Opening balance', s.openingBalance], ['Invoiced', s.totals.invoiced], ['Payments', -s.totals.paid],
      ...(s.totals.credited ? [['Credit notes', -s.totals.credited] as [string, number]] : []),
      ...(s.totals.refunded ? [['Refunds', s.totals.refunded] as [string, number]] : []),
    ];
    let sy = y;
    doc.setFontSize(9);
    for (const [label, v] of summary) {
      doc.setTextColor(80); doc.text(label, sx, sy);
      doc.setTextColor(0); doc.text(money(v), sx + sw, sy, { align: 'right' });
      sy += 5;
    }
    doc.setDrawColor(180); doc.setLineWidth(0.3); doc.line(sx, sy - 2, sx + sw, sy - 2);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(247, 145, 43);
    sy += 3;
    doc.text(s.closingBalance > 0.005 ? 'Balance due' : 'Balance', sx, sy);
    doc.text(money(s.closingBalance), sx + sw, sy, { align: 'right' });
    doc.setFont('helvetica', 'normal');

    // Transactions
    const rows = statementRows(s);
    autoTable(doc, {
      startY: Math.max(leftBottom, sy) + 6,
      head: [['Date', 'Document', 'Details', 'Due', 'Debit', 'Credit', 'Balance']],
      body: rows.map((r) => r.detail ? ['', '', { content: r.cells[2], colSpan: 4 }, ''] : r.cells),
      styles: { fontSize: 8, cellPadding: 1.8, textColor: 20 },
      headStyles: { fillColor: [30, 30, 30], textColor: 255, fontStyle: 'bold', fontSize: 8 },
      columnStyles: {
        0: { cellWidth: 18 }, 1: { cellWidth: 29, font: 'courier' }, 2: { cellWidth: 'auto' }, 3: { cellWidth: 19 },
        4: { halign: 'right', cellWidth: 20 }, 5: { halign: 'right', cellWidth: 20 }, 6: { halign: 'right', cellWidth: 22, fontStyle: 'bold' },
      },
      didParseCell: (h: any) => {
        if (h.section !== 'body') return;
        const r = rows[h.row.index];
        if (r?.detail) { h.cell.styles.fontSize = 7; h.cell.styles.textColor = 110; h.cell.styles.fontStyle = 'normal'; h.cell.styles.halign = 'left'; if (h.column.index === 2) h.cell.styles.cellPadding = { top: 1, bottom: 1, left: 6, right: 1.8 }; }
        else if (h.row.index === 0 || h.row.index === rows.length - 1) { h.cell.styles.fillColor = [245, 245, 245]; h.cell.styles.fontStyle = 'bold'; }
      },
      margin: { left: M, right: M, bottom: 16 },
      theme: 'grid',
    });

    // Aging + overdue
    let ay = ((doc as any).lastAutoTable?.finalY ?? y + 60) + 8;
    if (ay > doc.internal.pageSize.getHeight() - 35) { doc.addPage(); ay = 20; }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(0);
    doc.text('Aging of open invoices', M, ay);
    autoTable(doc, {
      startY: ay + 2,
      head: [['Current', '1-30 days', '31-60 days', '61+ days', 'Total open']],
      body: [[money(s.aging.current), money(s.aging.d30), money(s.aging.d60), money(s.aging.d90plus), money(s.aging.total)]],
      styles: { fontSize: 9, halign: 'right', cellPadding: 2 },
      headStyles: { fillColor: [247, 145, 43], textColor: 255, halign: 'right', fontSize: 8 },
      columnStyles: { 4: { fontStyle: 'bold' } },
      margin: { left: M, right: M }, theme: 'grid',
    });
    if (s.overdueInvoices.length) {
      const oy = (doc as any).lastAutoTable.finalY + 6;
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(200, 40, 40);
      doc.text(`Overdue invoices (${s.overdueInvoices.length})`, M, oy);
      autoTable(doc, {
        startY: oy + 2,
        head: [['Invoice', 'Date', 'Due', 'Days overdue', 'Owing']],
        body: s.overdueInvoices.map((o) => [o.number, o.date, o.dueDate ?? '', String(o.daysOverdue), money(o.amount)]),
        styles: { fontSize: 8, cellPadding: 1.8 },
        headStyles: { fillColor: [200, 40, 40], textColor: 255, fontSize: 8 },
        columnStyles: { 3: { halign: 'right' }, 4: { halign: 'right', fontStyle: 'bold' } },
        margin: { left: M, right: M }, theme: 'grid',
      });
    }
  });

  // Footer on every page
  const pages = doc.getNumberOfPages();
  const H = doc.internal.pageSize.getHeight();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(160);
    doc.text(`TRACKLAB IM · Generated ${new Date().toLocaleString()} · Page ${p} of ${pages}`, W / 2, H - 8, { align: 'center' });
  }

  const filename = statementFilename(statements, asOf);
  doc.save(filename);
  return filename;
}
