// A customer's history: every document, move and note, newest first.

import { sortHistory, type HistoryEntry } from './potentialOrders';

/** A customer's documents, moves and notes, newest first (the Customer 360 History tab and statements). */
export async function loadClientHistory(q: (sql: string, params?: any[]) => Promise<{ rows: any[] }>, clientId: number): Promise<HistoryEntry[]> {
  const day = (d: any) => (d ? new Date(d).toISOString() : '');
  const out: HistoryEntry[] = [];
  const base = { by: null, eventId: null, followUpDate: null, followUpDone: false } as const;
  const [orders, invoices, payments, credits, deliveries, pots, events] = await Promise.all([
    q(`SELECT order_number, order_date, created_at, status, total, currency FROM client_orders WHERE client_id = $1`, [clientId]),
    q(`SELECT invoice_number, invoice_date, created_at, status, total, currency, balance_due FROM invoices WHERE client_id = $1`, [clientId]),
    q(`SELECT payment_number, payment_date, created_at, amount, method FROM payments_received WHERE client_id = $1`, [clientId]),
    q(`SELECT credit_note_number, credit_date, created_at, status, total, currency, reason FROM credit_notes WHERE client_id = $1`, [clientId]),
    q(`SELECT note_number, note_type, note_date, created_at, status FROM dispatch_notes WHERE client_id = $1`, [clientId]),
    q(`SELECT number, created_at, status, total, currency, reason, likelihood_pct, expected_date FROM potential_orders WHERE client_id = $1`, [clientId]),
    q(`SELECT * FROM client_events WHERE client_id = $1`, [clientId]),
  ]);
  for (const o of orders.rows) {
    const quote = o.status === 'QUOTATION' || String(o.order_number).startsWith('QUO-');
    out.push({ ...base, at: day(o.created_at || o.order_date), kind: quote ? 'quotation' : 'sales_order', title: `${quote ? 'Quotation' : 'Sales order'} ${o.order_number}`, detail: `Now ${String(o.status).toLowerCase().replace(/_/g, ' ')}`, docNumber: o.order_number, amount: Number(o.total), currency: o.currency });
  }
  for (const i of invoices.rows) {
    out.push({ ...base, at: day(i.created_at || i.invoice_date), kind: 'invoice', title: `Invoice ${i.invoice_number}`, detail: `Now ${String(i.status).toLowerCase()}${Number(i.balance_due) > 0 && i.status !== 'VOID' ? `, ${Number(i.balance_due).toFixed(2)} due` : ''}`, docNumber: i.invoice_number, amount: Number(i.total), currency: i.currency });
  }
  for (const p of payments.rows) out.push({ ...base, at: day(p.created_at || p.payment_date), kind: 'payment', title: `Payment ${p.payment_number}`, detail: p.method || null, docNumber: p.payment_number, amount: Number(p.amount), currency: null });
  for (const c of credits.rows) out.push({ ...base, at: day(c.created_at || c.credit_date), kind: 'credit_note', title: `Credit note ${c.credit_note_number}`, detail: [String(c.status).toLowerCase(), c.reason].filter(Boolean).join(': '), docNumber: c.credit_note_number, amount: Number(c.total), currency: c.currency });
  for (const d of deliveries.rows) out.push({ ...base, at: day(d.created_at || d.note_date), kind: 'delivery', title: `${d.note_type === 'COLLECTION' ? 'Collection' : 'Delivery'} ${d.note_number}`, detail: `Now ${String(d.status).toLowerCase()}`, docNumber: d.note_number, amount: null, currency: null });
  for (const p of pots.rows) out.push({ ...base, at: day(p.created_at), kind: 'potential', title: `Potential Order ${p.number}`, detail: [String(p.status).toLowerCase(), p.likelihood_pct != null ? `${p.likelihood_pct}% likely` : null, p.reason].filter(Boolean).join(' · '), docNumber: p.number, amount: Number(p.total), currency: p.currency });
  for (const e of events.rows) {
    out.push({ at: day(e.created_at), kind: e.kind, title: e.kind === 'system' ? e.body : `${e.kind.charAt(0).toUpperCase()}${e.kind.slice(1)}`, detail: e.kind === 'system' ? null : e.body,
      docNumber: e.doc_number, amount: null, currency: null, by: e.created_by, eventId: e.id,
      followUpDate: e.follow_up_date ? new Date(e.follow_up_date).toISOString().slice(0, 10) : null, followUpDone: e.follow_up_done });
  }
  return sortHistory(out);
}
