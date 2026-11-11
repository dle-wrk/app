import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExpensesTab } from './ExpensesTab';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const EXPENSES = [
  { id: 4, expenseNumber: 'EXP-2026-0004', payee: 'Engen', categoryAccountName: 'Fuel', expenseDate: '2026-11-03', amount: 400, taxAmount: 60, total: 460, status: 'RECORDED' },
  { id: 3, expenseNumber: 'EXP-2026-0003', payee: 'Takealot', categoryAccountName: 'Office', expenseDate: '2026-10-20', amount: 100, taxAmount: 15, total: 115, status: 'RECORDED' },
  { id: 2, expenseNumber: 'EXP-2026-0002', payee: 'Wrong one', categoryAccountName: 'Office', expenseDate: '2026-10-02', amount: 900, taxAmount: 0, total: 900, status: 'VOID' },
];

const props: any = {
  accounts: [], taxRates: [], invoices: [], paymentsReceived: [], paymentsMade: [], bills: [], purchaseOrders: [],
  clients: [], suppliers: [], items: [], clientOrders: [],
  expenses: EXPENSES,
  triggerToast: vi.fn(),
  refresh: vi.fn(async () => {}),
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('Expenses grouped by month', () => {
  it('opens only the newest month, totals each month without voided expenses, and opens a month on click', async () => {
    await act(async () => { root.render(<ExpensesTab {...props} />); });
    const headers = () => Array.from(document.querySelectorAll<HTMLElement>('tr[aria-expanded]'));
    expect(headers().map(r => [r.textContent?.match(/^[A-Za-z]+ \d{4}/)?.[0], r.getAttribute('aria-expanded')]))
      .toEqual([['November 2026', 'true'], ['October 2026', 'false']]);
    expect(document.body.textContent).toContain('EXP-2026-0004');
    expect(document.body.textContent).not.toContain('EXP-2026-0003');
    expect(headers()[1].textContent).toContain('2 expenses');
    expect(headers()[1].textContent).toMatch(/R\s?115\.00/); // the voided R900 is left out
    await act(async () => { headers()[1].click(); });
    expect(document.body.textContent).toContain('EXP-2026-0003');
    expect(document.body.textContent).toContain('EXP-2026-0002');
  });
});
