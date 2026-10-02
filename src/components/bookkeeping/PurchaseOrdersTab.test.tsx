import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PurchaseOrdersTab } from './PurchaseOrdersTab';
import { ConfirmOptions, setConfirmHandler } from '../../lib/confirmDialog';

// Drives the real Purchase Orders tab with a stubbed API and a stubbed
// confirmation dialog, as an admin and as an ordinary user.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const PURCHASE_ORDERS = [
  { id: 6, poNumber: 'PO-2026-0006', supplierName: 'COMMUNICA', orderDate: '2026-09-22', status: 'RECEIVED', currency: 'ZAR', total: 3441.38 },
  { id: 3, poNumber: 'PO-2026-0003', supplierName: 'New World Menlyn', orderDate: '2026-08-03', status: 'CANCELLED', currency: 'ZAR', total: 1309.02 },
  { id: 9, poNumber: 'PO-2026-0009', supplierName: 'MOUSER', orderDate: '2026-10-01', status: 'DRAFT', currency: 'ZAR', total: 50 },
];
const BILLS = [
  { id: 5, billNumber: 'BILL-2026-0005', purchaseOrderId: 6, status: 'PAID' },
  { id: 2, billNumber: 'BILL-2026-0002', purchaseOrderId: 3, status: 'VOID' },
];

type Call = { method: string; url: string };
let calls: Call[];
let deleteReply: { status: number; body: unknown };
let confirmAnswer: boolean;
let confirms: ConfirmOptions[];
const toast = vi.fn();
const refresh = vi.fn(async () => {});

const reply = (data: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => data }) as unknown as Response;

const props: any = {
  accounts: [], taxRates: [], invoices: [], paymentsReceived: [], paymentsMade: [], expenses: [],
  clients: [], suppliers: [], items: [], clientOrders: [],
  purchaseOrders: PURCHASE_ORDERS,
  bills: BILLS,
  triggerToast: toast,
  refresh,
};

let host: HTMLDivElement;
let root: Root;

const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

async function renderAs(role: 'admin' | 'user') {
  localStorage.setItem('currentUser', JSON.stringify({ email: `${role}@example.com`, role }));
  await act(async () => { root.render(<PurchaseOrdersTab {...props} />); });
  await settle();
}

const rowDeleteButtons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Delete PO-"]'));
const rowDelete = (poNumber: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="Delete ${poNumber}"]`)!;
const buttonNamed = (label: string) =>
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);
const openViewer = async (poNumber: string) => {
  const cell = Array.from(document.querySelectorAll('td')).find((td) => td.textContent === poNumber)!;
  await act(async () => { cell.click(); });
  await settle();
};
const click = async (el: HTMLElement) => {
  await act(async () => { el.click(); });
  await settle();
};
const deletes = () => calls.filter((c) => c.method === 'DELETE');

beforeEach(() => {
  calls = [];
  deleteReply = { status: 200, body: { ok: true, unlinkedBills: [] } };
  confirmAnswer = true;
  confirms = [];
  toast.mockClear();
  refresh.mockClear();
  setConfirmHandler(async (opts) => { confirms.push(opts); return confirmAnswer; });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || 'GET').toUpperCase();
    calls.push({ method, url });
    const one = url.match(/^\/api\/purchase-orders\/(\d+)$/);
    if (one && method === 'GET') return reply({ ...PURCHASE_ORDERS.find((p) => p.id === Number(one[1])), items: [] });
    if (one && method === 'DELETE') return reply(deleteReply.body, deleteReply.status);
    return reply({ error: `unexpected ${method} ${url}` }, 500);
  }));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setConfirmHandler(null);
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('Purchase Orders — admin', () => {
  it('has a delete button on every row, whatever the status', async () => {
    await renderAs('admin');

    expect(rowDeleteButtons().map((b) => b.getAttribute('aria-label'))).toEqual([
      'Delete PO-2026-0006', 'Delete PO-2026-0003', 'Delete PO-2026-0009',
    ]);
  });

  it('warns about the bill raised from a received order, then deletes it', async () => {
    await renderAs('admin');

    await click(rowDelete('PO-2026-0006'));

    expect(confirms).toHaveLength(1);
    expect(confirms[0].title).toBe('Delete purchase order');
    expect(confirms[0].destructive).toBe(true);
    expect(confirms[0].message).toContain('Delete PO-2026-0006?');
    expect(confirms[0].message).toContain('It is RECEIVED');
    expect(confirms[0].message).toContain('cannot be undone');
    expect(confirms[0].message).toContain('One bill was raised from this order: BILL-2026-0005 (PAID).');
    expect(confirms[0].message).toContain('will no longer show which purchase order it came from');
    expect(deletes()).toEqual([{ method: 'DELETE', url: '/api/purchase-orders/6' }]);
    expect(toast).toHaveBeenCalledWith('PO-2026-0006 deleted.');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('deletes nothing when the confirmation is declined', async () => {
    confirmAnswer = false;
    await renderAs('admin');

    await click(rowDelete('PO-2026-0003'));

    expect(confirms).toHaveLength(1);
    expect(deletes()).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('keeps the draft confirmation short: no status, no bills', async () => {
    await renderAs('admin');

    await click(rowDelete('PO-2026-0009'));

    expect(confirms[0].title).toBe('Delete draft PO');
    expect(confirms[0].message).toBe('Delete draft PO-2026-0009? This cannot be undone.');
  });

  it('can delete from the viewer of a non-draft order too', async () => {
    await renderAs('admin');
    await openViewer('PO-2026-0003');

    await click(buttonNamed('Delete')!);

    expect(confirms[0].message).toContain('BILL-2026-0002 (VOID)');
    expect(deletes()).toEqual([{ method: 'DELETE', url: '/api/purchase-orders/3' }]);
  });

  it('shows the server’s reason when the delete is refused', async () => {
    deleteReply = { status: 403, body: { error: 'Only an admin can delete a purchase order that is RECEIVED.' } };
    await renderAs('admin');

    await click(rowDelete('PO-2026-0006'));

    expect(toast).toHaveBeenCalledWith('Only an admin can delete a purchase order that is RECEIVED.', 'ERROR');
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('Purchase Orders — ordinary user', () => {
  it('has no delete buttons on the list', async () => {
    await renderAs('user');

    expect(rowDeleteButtons()).toEqual([]);
  });

  it('is offered Delete in the viewer for a draft only', async () => {
    await renderAs('user');

    await openViewer('PO-2026-0006');
    expect(buttonNamed('Delete')).toBeUndefined();
    await click(document.querySelector<HTMLButtonElement>('button[aria-label="Close modal"]')!);

    await openViewer('PO-2026-0009');
    expect(buttonNamed('Delete')).toBeDefined();
  });
});
