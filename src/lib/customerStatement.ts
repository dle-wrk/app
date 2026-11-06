// Customer statements: every invoice (debit), payment and credit note
// (credits) and refund (debit) for a client, in date order with a running
// balance, plus the invoice lines, what each payment was applied to, and
// an aging matrix on what is still open.
//
// loadCustomerStatement reads the rows; assembleStatement is the pure
// part (ordering, running balance, aging) so it can be tested alone.

type Q = (sql: string, params?: any[]) => Promise<{ rows: any[] }>;

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v: any) => parseFloat(v) || 0;

export interface StatementLine { partNumber: string | null; description: string; quantity: number; unitPrice: number; lineTotal: number }
export interface StatementTxn {
  date: string;
  type: 'INVOICE' | 'PAYMENT' | 'CREDIT_NOTE' | 'REFUND';
  docNumber: string;
  description: string;
  debit: number;
  credit: number;
  runningBalance: number;
  dueDate?: string | null;
  status?: string;
  balanceDue?: number;
  subtotal?: number;
  tax?: number;
  discount?: number;
  lines?: StatementLine[];
  appliedTo?: Array<{ docNumber: string; amount: number }>;
  reference?: string | null;
  /** Every note on this document and the ones behind it (sales order, delivery notes). */
  notes?: string[];
}
export interface CustomerStatement {
  client: { id: number; name: string; contactName: string | null; email: string | null; phone: string | null; address: string | null; vatNumber: string | null; paymentTermsDays: number | null };
  period: { from: string | null; asOf: string };
  openingBalance: number;
  closingBalance: number;
  totals: { invoiced: number; paid: number; credited: number; refunded: number };
  transactions: StatementTxn[];
  aging: { current: number; d30: number; d60: number; d90plus: number; total: number };
  overdueInvoices: Array<{ number: string; date: string; dueDate: string | null; daysOverdue: number; amount: number }>;
}

const ORDER: Record<StatementTxn['type'], number> = { INVOICE: 0, REFUND: 1, CREDIT_NOTE: 2, PAYMENT: 3 };

export function assembleStatement(input: {
  client: CustomerStatement['client']; asOf: string; from: string | null; openingBalance: number;
  invoices: any[]; payments: any[]; creditNotes: any[];
}): CustomerStatement {
  const events: StatementTxn[] = [];
  for (const i of input.invoices) events.push({
    date: i.date, type: 'INVOICE', docNumber: i.number, description: 'Invoice',
    debit: num(i.total), credit: 0, runningBalance: 0, dueDate: i.dueDate ?? null,
    status: i.status, balanceDue: num(i.balanceDue), lines: i.lines ?? [],
    subtotal: num(i.subtotal), tax: num(i.tax), discount: num(i.discount), notes: i.notes ?? [],
  });
  for (const p of input.payments) events.push({
    date: p.date, type: 'PAYMENT', docNumber: p.number,
    description: ['Payment', p.method].filter(Boolean).join(' · '),
    debit: 0, credit: num(p.amount), runningBalance: 0, reference: p.reference ?? null, appliedTo: p.appliedTo ?? [], notes: p.notes ?? [],
  });
  for (const c of input.creditNotes) {
    events.push({
      date: c.date, type: 'CREDIT_NOTE', docNumber: c.number,
      description: ['Credit note', c.invoiceNumber ? `against ${c.invoiceNumber}` : '', c.reason].filter(Boolean).join(' · '),
      debit: 0, credit: num(c.total), runningBalance: 0, status: c.status, lines: c.lines ?? [], notes: c.notes ?? [],
    });
    if (num(c.refunded) > 0) events.push({
      date: c.date, type: 'REFUND', docNumber: c.number, description: 'Refund of credit note',
      debit: num(c.refunded), credit: 0, runningBalance: 0,
    });
  }
  events.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : ORDER[a.type] - ORDER[b.type]);

  let running = input.openingBalance;
  for (const e of events) { running += e.debit - e.credit; e.runningBalance = r2(running); }

  const asOfMs = Date.parse(input.asOf);
  const aging = { current: 0, d30: 0, d60: 0, d90plus: 0, total: 0 };
  const overdueInvoices: CustomerStatement['overdueInvoices'] = [];
  for (const i of input.invoices) {
    const open = num(i.balanceDue);
    if (open <= 0.005) continue;
    const days = Math.floor((asOfMs - Date.parse(i.dueDate || i.date)) / 86_400_000);
    if (days <= 0) aging.current += open;
    else if (days <= 30) aging.d30 += open;
    else if (days <= 60) aging.d60 += open;
    else aging.d90plus += open;
    aging.total += open;
    if (days > 0) overdueInvoices.push({ number: i.number, date: i.date, dueDate: i.dueDate ?? null, daysOverdue: days, amount: r2(open) });
  }
  overdueInvoices.sort((a, b) => b.daysOverdue - a.daysOverdue);

  const sum = (t: StatementTxn['type'], k: 'debit' | 'credit') => r2(events.filter((e) => e.type === t).reduce((s, e) => s + e[k], 0));
  return {
    client: input.client,
    period: { from: input.from, asOf: input.asOf },
    openingBalance: r2(input.openingBalance),
    closingBalance: r2(running),
    totals: { invoiced: sum('INVOICE', 'debit'), paid: sum('PAYMENT', 'credit'), credited: sum('CREDIT_NOTE', 'credit'), refunded: sum('REFUND', 'debit') },
    transactions: events,
    aging: { current: r2(aging.current), d30: r2(aging.d30), d60: r2(aging.d60), d90plus: r2(aging.d90plus), total: r2(aging.total) },
    overdueInvoices,
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isIsoDate = (s: string) => DATE_RE.test(s) && !Number.isNaN(Date.parse(s));

/** Null when there is no such client. */
export async function loadCustomerStatement(q: Q, clientId: number, asOf: string, from: string | null): Promise<CustomerStatement | null> {
  const c = (await q(`SELECT id, client_name, contact_name, email, phone, address, vat_number, payment_terms_days, opening_balance FROM clients WHERE id = $1`, [clientId])).rows[0];
  if (!c) return null;
  // $2 = asOf, $3 = from (or null for "since the start").
  const window = (col: string) => `${col} <= $2::date AND ($3::date IS NULL OR ${col} >= $3::date)`;
  const params = [clientId, asOf, from];

  const invoices = (await q(`
    SELECT id, invoice_number AS number, to_char(invoice_date, 'YYYY-MM-DD') AS date, to_char(due_date, 'YYYY-MM-DD') AS "dueDate",
           subtotal, tax_total AS tax, discount_total AS discount, total, balance_due AS "balanceDue", status,
           notes AS note_text, terms AS terms_text, client_order_id
    FROM invoices
    WHERE client_id = $1 AND ${window('invoice_date')} AND status NOT IN ('DRAFT', 'VOID')
    ORDER BY invoice_date, id`, params)).rows;
  const payments = (await q(`
    SELECT id, payment_number AS number, to_char(payment_date, 'YYYY-MM-DD') AS date, amount, method, reference, notes AS note_text
    FROM payments_received
    WHERE client_id = $1 AND ${window('payment_date')}
    ORDER BY payment_date, id`, params)).rows;
  const creditNotes = (await q(`
    SELECT cn.id, cn.credit_note_number AS number, to_char(cn.credit_date, 'YYYY-MM-DD') AS date, cn.total, cn.amount_refunded AS refunded,
           cn.reason, cn.status, cn.notes AS note_text, i.invoice_number AS "invoiceNumber"
    FROM credit_notes cn LEFT JOIN invoices i ON i.id = cn.invoice_id
    WHERE cn.client_id = $1 AND ${window('cn.credit_date')} AND cn.status NOT IN ('DRAFT', 'VOID')
    ORDER BY cn.credit_date, cn.id`, params)).rows;

  const ids = (rows: any[]) => rows.map((r) => r.id);
  const line = (r: any): StatementLine => ({ partNumber: r.part_number || null, description: r.description || '', quantity: num(r.quantity), unitPrice: num(r.unit_price), lineTotal: num(r.line_total) });
  const group = <T>(rows: any[], key: string, map: (r: any) => T) => {
    const m = new Map<number, T[]>();
    for (const r of rows) { const k = Number(r[key]); if (!m.has(k)) m.set(k, []); m.get(k)!.push(map(r)); }
    return m;
  };
  const clean = (v: any) => (typeof v === 'string' ? v.trim() : '');
  for (const p of payments) p.notes = clean(p.note_text) ? [clean(p.note_text)] : [];
  for (const cn of creditNotes) cn.notes = clean(cn.note_text) ? [clean(cn.note_text)] : [];
  if (invoices.length) {
    // Notes from the invoice itself, its sales order and its delivery/collection notes.
    const orderIds = invoices.map((i) => i.client_order_id).filter((x) => x != null);
    const orderNotes = new Map<number, { number: string; notes: string }>();
    if (orderIds.length) for (const r of (await q(`SELECT id, order_number, notes FROM client_orders WHERE id = ANY($1::int[])`, [orderIds])).rows) orderNotes.set(Number(r.id), { number: r.order_number, notes: clean(r.notes) });
    const dispatch = group((await q(`SELECT invoice_id, client_order_id, note_number, note_type, notes FROM dispatch_notes WHERE (invoice_id = ANY($1::int[]) OR client_order_id = ANY($2::int[])) AND COALESCE(TRIM(notes), '') <> '' ORDER BY id`, [ids(invoices), orderIds])).rows,
      'invoice_id', (r) => r);
    const dispatchByOrder = new Map<number, any[]>();
    for (const list of dispatch.values()) for (const r of list) if (r.client_order_id != null) { const k = Number(r.client_order_id); if (!dispatchByOrder.has(k)) dispatchByOrder.set(k, []); dispatchByOrder.get(k)!.push(r); }
    for (const i of invoices) {
      const notes: string[] = [];
      if (clean(i.note_text)) notes.push(clean(i.note_text));
      if (clean(i.terms_text)) notes.push(`Terms: ${clean(i.terms_text)}`);
      const o = i.client_order_id != null ? orderNotes.get(Number(i.client_order_id)) : undefined;
      if (o?.notes) notes.push(`${o.number}: ${o.notes}`);
      const seen = new Set<string>();
      for (const d of [...(dispatch.get(i.id) ?? []), ...(i.client_order_id != null ? dispatchByOrder.get(Number(i.client_order_id)) ?? [] : [])]) {
        if (seen.has(d.note_number)) continue;
        seen.add(d.note_number);
        notes.push(`${d.note_number} (${d.note_type === 'COLLECTION' ? 'collection' : 'delivery'}): ${clean(d.notes)}`);
      }
      i.notes = notes;
    }
    const byInv = group((await q(`SELECT invoice_id, part_number, description, quantity, unit_price, line_total FROM invoice_items WHERE invoice_id = ANY($1::int[]) ORDER BY invoice_id, id`, [ids(invoices)])).rows, 'invoice_id', line);
    for (const i of invoices) i.lines = byInv.get(i.id) ?? [];
  }
  if (creditNotes.length) {
    const byCn = group((await q(`SELECT credit_note_id, part_number, description, quantity, unit_price, line_total FROM credit_note_items WHERE credit_note_id = ANY($1::int[]) ORDER BY credit_note_id, id`, [ids(creditNotes)])).rows, 'credit_note_id', line);
    for (const cn of creditNotes) cn.lines = byCn.get(cn.id) ?? [];
  }
  if (payments.length) {
    const byPay = group((await q(`SELECT a.payment_id, i.invoice_number, a.amount_applied FROM payment_receipt_allocations a JOIN invoices i ON i.id = a.invoice_id WHERE a.payment_id = ANY($1::int[]) ORDER BY a.payment_id, a.id`, [ids(payments)])).rows,
      'payment_id', (r) => ({ docNumber: r.invoice_number as string, amount: num(r.amount_applied) }));
    for (const p of payments) p.appliedTo = byPay.get(p.id) ?? [];
  }

  return assembleStatement({
    client: { id: c.id, name: c.client_name, contactName: c.contact_name || null, email: c.email || null, phone: c.phone || null, address: c.address || null, vatNumber: c.vat_number || null, paymentTermsDays: c.payment_terms_days ?? null },
    asOf, from, openingBalance: num(c.opening_balance), invoices, payments, creditNotes,
  });
}
