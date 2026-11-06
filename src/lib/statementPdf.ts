// Customer statement PDF, for one customer or for all of them. The
// all-customers PDF is one statement ("All Customers") with each customer's
// documents grouped under their name, sorted by customer, and grand totals.
// Each statement covers the first transaction to the as-of date. It shows
// the customer's details, a summary, every transaction with a running
// balance (invoice lines and VAT, what each payment paid, credit-note lines,
// every note), the aging matrix and the overdue invoices.

import { fmtCurrency } from './formatMoney';
import { loadPdfLib } from './pdfDocs';
import type { CustomerStatement, StatementTxn } from './customerStatement';

const money = (n: number) => fmtCurrency(Number(n) || 0, 'ZAR');
const TYPE_LABEL: Record<StatementTxn['type'], string> = { INVOICE: 'Invoice', PAYMENT: 'Payment', CREDIT_NOTE: 'Credit note', REFUND: 'Refund' };
const r2 = (n: number) => Math.round(n * 100) / 100;

/** detail: a line under a document; edge: opening/closing; group: a customer's name; total: the grand total. */
export type StatementRow = { cells: string[]; kind?: 'detail' | 'edge' | 'group' | 'total' };

/** When a statement starts: its from date, else its first transaction, else the as-of date. */
export function statementStart(s: CustomerStatement): string {
  return s.period.from ?? s.transactions[0]?.date ?? s.period.asOf;
}

/** The transactions table: one row per document, with its details under it. */
export function statementRows(s: CustomerStatement, closingLabel = 'Closing balance'): StatementRow[] {
  const rows: StatementRow[] = [{ cells: [statementStart(s), '', 'Opening balance', '', '', '', money(s.openingBalance)], kind: 'edge' }];
  // Detail rows span Details..Credit in the PDF, so any amount goes in the text, not under Debit.
  const detail = (text: string, amount = ''): StatementRow => ({ cells: ['', '', amount ? `${text}: ${amount}` : text, '', '', '', ''], kind: 'detail' });
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
  if (!s.transactions.length) rows.push(detail('No invoices, payments or credit notes yet'));
  rows.push({ cells: [s.period.asOf, '', closingLabel, '', '', '', money(s.closingBalance)], kind: 'edge' });
  return rows;
}

const byName = (a: CustomerStatement, b: CustomerStatement) => a.client.name.localeCompare(b.client.name, undefined, { sensitivity: 'base' });

/** Every customer's rows, sorted by customer, under their name, then the grand total. */
export function allCustomerRows(statements: CustomerStatement[]): StatementRow[] {
  const sorted = [...statements].sort(byName);
  const rows: StatementRow[] = [];
  for (const s of sorted) {
    rows.push({ cells: ['', '', s.client.name, '', '', '', ''], kind: 'group' });
    rows.push(...statementRows(s, `Closing balance: ${s.client.name}`));
  }
  const sum = (k: 'debit' | 'credit') => r2(sorted.reduce((n, s) => n + s.transactions.reduce((m, t) => m + t[k], 0), 0));
  rows.push({ cells: ['', '', `All customers (${sorted.length})`, '', money(sum('debit')), money(sum('credit')), money(r2(sorted.reduce((n, s) => n + s.closingBalance, 0)))], kind: 'total' });
  return rows;
}

/** One statement covering every customer: totals, aging and overdue invoices added up. */
export function combineStatements(statements: CustomerStatement[]) {
  const sorted = [...statements].sort(byName);
  const add = (f: (s: CustomerStatement) => number) => r2(sorted.reduce((n, s) => n + f(s), 0));
  const starts = sorted.map(statementStart).sort();
  return {
    customers: sorted.length,
    start: starts[0] ?? null,
    openingBalance: add((s) => s.openingBalance),
    closingBalance: add((s) => s.closingBalance),
    totals: { invoiced: add((s) => s.totals.invoiced), paid: add((s) => s.totals.paid), credited: add((s) => s.totals.credited), refunded: add((s) => s.totals.refunded) },
    aging: { current: add((s) => s.aging.current), d30: add((s) => s.aging.d30), d60: add((s) => s.aging.d60), d90plus: add((s) => s.aging.d90plus), total: add((s) => s.aging.total) },
    overdue: sorted.flatMap((s) => s.overdueInvoices.map((o) => ({ customer: s.client.name, ...o }))),
  };
}

export type SectionRow = { cells: string[]; detail?: string };
export interface SectionTable { title: string; head: string[]; rows: SectionRow[]; right: number[] }

const status = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');

/**
 * The Customer 360 tabs as tables: Overview, Orders & Quotes, Invoices,
 * Payments, Credit Notes, Deliveries and History. With several customers
 * each table gets a Customer column and the rows are sorted by customer.
 */
export function sectionTables(statements: CustomerStatement[], all: boolean): SectionTable[] {
  const list = [...statements].sort(byName).filter((s) => s.sections);
  const who = (s: CustomerStatement) => (all ? [s.client.name] : []);
  const C = all ? ['Customer'] : [];
  const shift = (cols: number[]) => cols.map((c) => c + C.length);
  const each = <T>(pick: (s: CustomerStatement) => T[], row: (s: CustomerStatement, x: T) => SectionRow[]) => list.flatMap((s) => pick(s).flatMap((x) => row(s, x)));

  const overview: SectionRow[] = list.map((s) => {
    const o = s.sections!.overview;
    return { cells: [...who(s), money(o.openAr), o.overdueCount ? `${money(o.overdue)} (${o.overdueCount})` : money(0), String(o.openOrders), String(o.quotes), money(o.lifetimeRevenue)] };
  });
  const lineText = (l: { partNumber: string | null; description: string; quantity: number; unitPrice: number; lineTotal: number }) =>
    `${l.partNumber ? `${l.partNumber}  ` : ''}${l.description}  ·  ${l.quantity} × ${money(l.unitPrice)} = ${money(l.lineTotal)}`;

  return [
    { title: 'Overview', head: [...C, 'Open AR', 'Overdue', 'Open orders', 'Quotes', 'Lifetime revenue'], rows: overview, right: shift([0, 1, 2, 3, 4]) },
    { title: 'Orders & Quotes', head: [...C, 'Number', 'Date', 'Required', 'Status', 'Total'], right: shift([4]),
      rows: each((s) => s.sections!.orders, (s, o) => [
        { cells: [...who(s), o.number, o.date, o.requiredDate ?? '', status(o.status), money(o.total)] },
        ...o.lines.map((l) => ({ cells: [], detail: lineText(l) })),
        ...(o.notes ? [{ cells: [], detail: `Note: ${o.notes}` }] : []),
      ]) },
    { title: 'Invoices', head: [...C, 'Number', 'Date', 'Due', 'Status', 'Total', 'Paid', 'Balance'], right: shift([4, 5, 6]),
      rows: each((s) => s.sections!.invoices, (s, i) => [{ cells: [...who(s), i.number, i.date, i.dueDate ?? '', status(i.status), money(i.total), money(i.paid), money(i.balance)] }]) },
    { title: 'Payments', head: [...C, 'Number', 'Date', 'Method', 'Reference', 'Amount', 'Unallocated'], right: shift([4, 5]),
      rows: each((s) => s.sections!.payments, (s, p) => [{ cells: [...who(s), p.number, p.date, p.method ?? '', p.reference ?? '', money(p.amount), money(p.unallocated)] }]) },
    { title: 'Credit Notes', head: [...C, 'Number', 'Date', 'Invoice', 'Status', 'Total', 'Applied', 'Refunded'], right: shift([4, 5, 6]),
      rows: each((s) => s.sections!.creditNotes, (s, c) => [
        { cells: [...who(s), c.number, c.date, c.invoiceNumber ?? '', status(c.status), money(c.total), money(c.applied), money(c.refunded)] },
        ...(c.reason ? [{ cells: [], detail: `Reason: ${c.reason}` }] : []),
      ]) },
    { title: 'Deliveries', head: [...C, 'Number', 'Type', 'Date', 'Status', 'Order', 'Invoice'], right: [],
      rows: each((s) => s.sections!.deliveries, (s, d) => [
        { cells: [...who(s), d.number, d.type === 'COLLECTION' ? 'Collection' : 'Delivery', d.date, status(d.status), d.orderNumber ?? '', d.invoiceNumber ?? ''] },
        ...d.items.map((it) => ({ cells: [], detail: `${it.partNumber ? `${it.partNumber}  ` : ''}${it.description}  ·  ${it.quantity}${it.serials ? `  ·  S/N ${it.serials}` : ''}` })),
        ...[d.scheduledDate ? `Scheduled ${d.scheduledDate}` : '', d.contact ? `Contact: ${d.contact}` : '', d.address ? `Address: ${d.address}` : '', d.carrier ? `Carrier: ${d.carrier}` : '', d.reference ? `Ref ${d.reference}` : '']
          .filter(Boolean).map((t) => ({ cells: [], detail: t })),
        ...(d.notes ? [{ cells: [], detail: `Note: ${d.notes}` }] : []),
      ]) },
    { title: 'History', head: [...C, 'Date', 'What', 'Details', 'Amount', 'By'], right: shift([3]),
      rows: each((s) => s.sections!.history, (s, h) => [
        { cells: [...who(s), h.at, h.title, [h.detail, h.followUp ? `follow up ${h.followUp}` : ''].filter(Boolean).join(' · '), h.amount != null ? money(h.amount) : '', h.by ?? ''] },
      ]) },
  ];
}

const slug = (s: string) => s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/(^-|-$)/g, '');

export function statementFilename(statements: CustomerStatement[], asOf: string): string {
  return statements.length === 1
    ? `customer-statement-${slug(statements[0].client.name)}-${asOf}.pdf`
    : `customer-statements-all-${asOf}.pdf`;
}

/**
 * One customer's statement, or (several) one All Customers statement.
 * `all` forces the All Customers layout even when only one customer has activity.
 */
export async function saveStatementsPdf(statements: CustomerStatement[], asOf: string, opts: { all?: boolean } = {}): Promise<string> {
  const { jsPDF, autoTable } = await loadPdfLib();
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  const W = doc.internal.pageSize.getWidth();
  const M = 15;
  const all = opts.all || statements.length > 1;

  const one = statements[0];
  const c = all ? combineStatements(statements) : null;
  const start = c ? (c.start ?? asOf) : statementStart(one);
  const totals = c ? c.totals : one.totals;
  const opening = c ? c.openingBalance : one.openingBalance;
  const closing = c ? c.closingBalance : one.closingBalance;
  const aging = c ? c.aging : one.aging;
  const overdue = c ? c.overdue : one.overdueInvoices.map((o) => ({ customer: one.client.name, ...o }));
  const rows = c ? allCustomerRows(statements) : statementRows(one);

  // Header
  doc.setTextColor(247, 145, 43); doc.setFont('helvetica', 'bold'); doc.setFontSize(26);
  doc.text('TRACKLAB', M, 22);
  doc.setFontSize(9); doc.setTextColor(120);
  doc.text('INVENTORY · MANUFACTURING · COMPLIANCE', M, 28);
  doc.setTextColor(0); doc.setFontSize(18);
  doc.text('Customer Statement', W - M, 22, { align: 'right' });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(80);
  doc.text(`${start} to ${asOf}`, W - M, 28, { align: 'right' });
  doc.setDrawColor(247, 145, 43); doc.setLineWidth(0.8); doc.line(M, 32, W - M, 32);

  // Who it is for (left) and summary (right)
  const y = 40;
  doc.setFontSize(8); doc.setTextColor(120); doc.text('STATEMENT FOR', M, y);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(0);
  doc.text(c ? 'All Customers' : one.client.name, M, y + 6);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(50);
  const who = c
    ? [`${c.customers} customer${c.customers === 1 ? '' : 's'}, sorted by name`, `${statements.filter((s) => s.transactions.length).length} with activity`, `${start} to ${asOf}`]
    : [
        one.client.contactName ? `Attn: ${one.client.contactName}` : '',
        ...(one.client.address ? doc.splitTextToSize(one.client.address, W / 2 - M - 5) : []),
        one.client.email ?? '', one.client.phone ?? '',
        one.client.vatNumber ? `VAT no. ${one.client.vatNumber}` : '',
        one.client.paymentTermsDays != null ? `Terms: ${one.client.paymentTermsDays} days` : '',
      ].filter(Boolean);
  who.forEach((line: string, i: number) => doc.text(line, M, y + 12 + i * 4.5));
  const leftBottom = y + 12 + who.length * 4.5;

  const sx = W / 2 + 5, sw = W - M - sx;
  const summary: Array<[string, number]> = [
    ['Opening balance', opening], ['Invoiced', totals.invoiced], ['Payments', -totals.paid],
    ...(totals.credited ? [['Credit notes', -totals.credited] as [string, number]] : []),
    ...(totals.refunded ? [['Refunds', totals.refunded] as [string, number]] : []),
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
  doc.text(closing > 0.005 ? 'Balance due' : 'Balance', sx, sy);
  doc.text(money(closing), sx + sw, sy, { align: 'right' });
  doc.setFont('helvetica', 'normal');

  // Transactions
  autoTable(doc, {
    startY: Math.max(leftBottom, sy) + 6,
    head: [['Date', 'Document', 'Details', 'Due', 'Debit', 'Credit', 'Balance']],
    body: rows.map((r) =>
      r.kind === 'detail' ? ['', '', { content: r.cells[2], colSpan: 4 }, '']
      : r.kind === 'group' ? [{ content: r.cells[2], colSpan: 7 }]
      : r.cells),
    styles: { fontSize: 8, cellPadding: 1.8, textColor: 20 },
    headStyles: { fillColor: [30, 30, 30], textColor: 255, fontStyle: 'bold', fontSize: 8 },
    columnStyles: {
      0: { cellWidth: 18 }, 1: { cellWidth: 29, font: 'courier' }, 2: { cellWidth: 'auto' }, 3: { cellWidth: 19 },
      4: { halign: 'right', cellWidth: 20 }, 5: { halign: 'right', cellWidth: 20 }, 6: { halign: 'right', cellWidth: 22, fontStyle: 'bold' },
    },
    didParseCell: (h: any) => {
      if (h.section !== 'body') return;
      const r = rows[h.row.index];
      if (r?.kind === 'detail') { h.cell.styles.fontSize = 7; h.cell.styles.textColor = 110; h.cell.styles.fontStyle = 'normal'; h.cell.styles.halign = 'left'; if (h.column.index === 2) h.cell.styles.cellPadding = { top: 1, bottom: 1, left: 6, right: 1.8 }; }
      else if (r?.kind === 'group') { h.cell.styles.fillColor = [253, 236, 214]; h.cell.styles.fontStyle = 'bold'; h.cell.styles.fontSize = 10; h.cell.styles.font = 'helvetica'; h.cell.styles.halign = 'left'; h.cell.styles.textColor = [150, 80, 10]; }
      else if (r?.kind === 'edge') { h.cell.styles.fillColor = [245, 245, 245]; h.cell.styles.fontStyle = 'bold'; }
      else if (r?.kind === 'total') { h.cell.styles.fillColor = [30, 30, 30]; h.cell.styles.textColor = 255; h.cell.styles.fontStyle = 'bold'; }
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
    body: [[money(aging.current), money(aging.d30), money(aging.d60), money(aging.d90plus), money(aging.total)]],
    styles: { fontSize: 9, halign: 'right', cellPadding: 2 },
    headStyles: { fillColor: [247, 145, 43], textColor: 255, halign: 'right', fontSize: 8 },
    columnStyles: { 4: { fontStyle: 'bold' } },
    margin: { left: M, right: M }, theme: 'grid',
  });
  if (overdue.length) {
    const oy = (doc as any).lastAutoTable.finalY + 6;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(200, 40, 40);
    doc.text(`Overdue invoices (${overdue.length})`, M, oy);
    autoTable(doc, {
      startY: oy + 2,
      head: [[...(c ? ['Customer'] : []), 'Invoice', 'Date', 'Due', 'Days overdue', 'Owing']],
      body: overdue.map((o) => [...(c ? [o.customer] : []), o.number, o.date, o.dueDate ?? '', String(o.daysOverdue), money(o.amount)]),
      styles: { fontSize: 8, cellPadding: 1.8 },
      headStyles: { fillColor: [200, 40, 40], textColor: 255, fontSize: 8 },
      columnStyles: c ? { 4: { halign: 'right' }, 5: { halign: 'right', fontStyle: 'bold' } } : { 3: { halign: 'right' }, 4: { halign: 'right', fontStyle: 'bold' } },
      margin: { left: M, right: M }, theme: 'grid',
    });
  }

  // The Customer 360 tabs
  for (const t of sectionTables(statements, all)) {
    let ty = ((doc as any).lastAutoTable?.finalY ?? 40) + 8;
    if (ty > doc.internal.pageSize.getHeight() - 35) { doc.addPage(); ty = 20; }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(0);
    doc.text(`${t.title} (${t.title === 'Overview' ? t.rows.length : t.rows.filter((r) => !r.detail).length})`, M, ty);
    const span = t.head.length;
    const body = t.rows.length
      ? t.rows.map((r) => (r.detail ? [{ content: r.detail, colSpan: span }] : r.cells))
      : [[{ content: 'None', colSpan: span }]];
    const colStyles: any = {};
    for (const i of t.right) colStyles[i] = { halign: 'right' };
    if (all) colStyles[0] = { ...(colStyles[0] ?? {}), cellWidth: 30 };
    autoTable(doc, {
      startY: ty + 2,
      head: [t.head],
      body,
      styles: { fontSize: 8, cellPadding: 1.6, textColor: 20 },
      headStyles: { fillColor: [60, 60, 60], textColor: 255, fontSize: 8 },
      columnStyles: colStyles,
      didParseCell: (h: any) => {
        if (h.section !== 'body' || !t.rows[h.row.index]?.detail) return;
        h.cell.styles.fontSize = 7; h.cell.styles.textColor = 110; h.cell.styles.halign = 'left';
        h.cell.styles.cellPadding = { top: 0.8, bottom: 0.8, left: 6, right: 1.6 };
      },
      margin: { left: M, right: M, bottom: 16 }, theme: 'grid',
    });
  }

  // Footer on every page
  const pages = doc.getNumberOfPages();
  const H = doc.internal.pageSize.getHeight();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(160);
    doc.text(`TRACKLAB IM · Generated ${new Date().toLocaleString()} · Page ${p} of ${pages}`, W / 2, H - 8, { align: 'center' });
  }

  const filename = all ? `customer-statements-all-${asOf}.pdf` : statementFilename(statements, asOf);
  doc.save(filename);
  return filename;
}
