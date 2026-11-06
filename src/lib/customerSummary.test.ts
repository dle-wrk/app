import { describe, it, expect } from 'vitest';
import { customerSummaries } from './customerSummary';

const clients: any[] = [
  { id: 1, clientName: 'Lumax Energy', status: 'ACTIVE', createdAt: '', openingBalance: 100 },
  { id: 2, clientName: 'Bokpoort', status: 'ACTIVE', createdAt: '' },
];
const invoices: any[] = [
  { clientId: 1, invoiceDate: '2026-09-09', dueDate: '2026-10-09', status: 'PARTIAL', total: 1000, balanceDue: 400 },
  { clientId: 1, invoiceDate: '2026-10-20', dueDate: '2026-11-19', status: 'SENT', total: 500, balanceDue: 500 },
  { clientId: 1, invoiceDate: '2026-11-01', status: 'DRAFT', total: 999, balanceDue: 999 },
  { clientId: 9, invoiceDate: '2026-11-01', status: 'SENT', total: 5, balanceDue: 5 },
];
const payments: any[] = [{ clientId: 1, paymentDate: '2026-10-25', amount: 600 }];
const orders: any[] = [
  { clientId: 1, orderDate: '2026-11-03', status: 'CONFIRMED' },
  { clientId: 1, orderDate: '2026-08-01', status: 'QUOTATION' },
  { clientId: 1, orderDate: '2026-08-02', status: 'FULFILLED' },
];

describe('customer summaries', () => {
  it('adds up each customer, leaving out drafts', () => {
    const m = customerSummaries(clients, invoices, payments, orders, '2026-11-06');
    expect(m.get(1)).toEqual({ openOrders: 1, quotes: 1, invoices: 2, invoiced: 1500, paid: 600, balance: 1000, overdue: 400, overdueCount: 1, lastActivity: '2026-11-03' });
  });

  it('gives a customer with nothing an empty row', () => {
    const m = customerSummaries(clients, invoices, payments, orders, '2026-11-06');
    expect(m.get(2)).toEqual({ openOrders: 0, quotes: 0, invoices: 0, invoiced: 0, paid: 0, balance: 0, overdue: 0, overdueCount: 0, lastActivity: null });
    expect(m.size).toBe(2);
  });
});
