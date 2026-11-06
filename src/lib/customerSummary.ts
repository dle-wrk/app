// Per-customer figures for the Customers list: orders, invoices, what was
// invoiced and paid, what is owed and overdue, and the last activity.

import type { Client, ClientOrder, Invoice, PaymentReceived } from '../types';

export interface CustomerSummary {
  openOrders: number;
  quotes: number;
  invoices: number;
  invoiced: number;
  paid: number;
  balance: number;
  overdue: number;
  overdueCount: number;
  lastActivity: string | null;
}

const EMPTY: CustomerSummary = { openOrders: 0, quotes: 0, invoices: 0, invoiced: 0, paid: 0, balance: 0, overdue: 0, overdueCount: 0, lastActivity: null };
const r2 = (n: number) => Math.round(n * 100) / 100;
const day = (s?: string | null) => (s ? String(s).slice(0, 10) : '');

export function customerSummaries(
  clients: Client[], invoices: Invoice[], payments: PaymentReceived[], orders: ClientOrder[], today: string,
): Map<number, CustomerSummary> {
  const out = new Map<number, CustomerSummary>();
  for (const c of clients) out.set(c.id, { ...EMPTY, balance: Number(c.openingBalance) || 0 });
  const at = (id?: number | null) => (id != null ? out.get(id) : undefined);
  const seen = (s: CustomerSummary, d?: string | null) => { const x = day(d); if (x && (!s.lastActivity || x > s.lastActivity)) s.lastActivity = x; };

  for (const i of invoices) {
    const s = at(i.clientId);
    if (!s || i.status === 'DRAFT' || i.status === 'VOID') continue;
    s.invoices++;
    s.invoiced += Number(i.total) || 0;
    const open = Number(i.balanceDue) || 0;
    s.balance += open;
    if (open > 0.005 && i.dueDate && day(i.dueDate) < today) { s.overdue += open; s.overdueCount++; }
    seen(s, i.invoiceDate);
  }
  for (const p of payments) {
    const s = at(p.clientId);
    if (!s) continue;
    s.paid += Number(p.amount) || 0;
    seen(s, p.paymentDate);
  }
  for (const o of orders) {
    const s = at(o.clientId);
    if (!s) continue;
    if (o.status === 'QUOTATION') s.quotes++;
    else if (o.status !== 'FULFILLED' && o.status !== 'CANCELLED') s.openOrders++;
    seen(s, o.orderDate);
  }
  for (const s of out.values()) { s.invoiced = r2(s.invoiced); s.paid = r2(s.paid); s.balance = r2(s.balance); s.overdue = r2(s.overdue); }
  return out;
}
