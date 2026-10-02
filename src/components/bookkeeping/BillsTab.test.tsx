import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BillsTab } from './BillsTab';
import { ConfirmOptions, setConfirmHandler } from '../../lib/confirmDialog';

// Drives the real Bills tab with a stubbed API and a stubbed confirmation
// dialog, as an admin and as an ordinary user.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const BILLS = [
  { id: 5, billNumber: 'BILL-2026-0005', supplierName: 'COMMUNICA', billDate: '2026-09-23', dueDate: '2026-10-23', status: 'PAID', currency: 'ZAR', subtotal: 2992.5, taxTotal: 448.88, total: 3441.38, amountPaid: 3441.38, balanceDue: 0 },
  { id: 2, billNumber: 'BILL-2026-0002', supplierName: 'New World Menlyn', billDate: '2026-08-13', dueDate: '2026-09-12', status: 'VOID', currency: 'ZAR', subtotal: 1138.28, taxTotal: 170.74, total: 1309.02, amountPaid: 0, balanceDue: 0 },
  { id: 8, billNumber: 'BILL-2026-0008', supplierName: 'MOUSER', billDate: '2026-10-01', dueDate: '2026-10-31', status: 'AWAITING_PAYMENT', currency: 'ZAR', subtotal: 100, taxTotal: 15, total: 115, amountPaid: 0, balanceDue: 115 },
  { id: 9, billNumber: 'BILL-2026-0009', supplierName: 'MOUSER', billDate: '2026-10-02', dueDate: '2026-11-01', status: 'DRAFT', currency: 'ZAR', subtotal: 50, taxTotal: 0, total: 50, amountPaid: 0, balanceDue: 50 },
];

const impactFor = (id: number, over: Record<string, unknown> = {}) => {
  const b = BILLS.find((x) => x.id === id)!;
  return {
    billNumber: b.billNumber, status: b.status, currency: b.currency, hasReceipt: false,
    reverseLedger: !['DRAFT', 'VOID'].includes(b.status),
    payments: [], stockKept: [], blockers: [],
    ...over,
  };
};

type Call = { method: string; url: string };
let calls: Call[];
let impacts: Record<number, { status: number; body: unknown }>;
let deleteReply: { status: number; body: unknown };
let confirmAnswer: boolean;
let confirms: ConfirmOptions[];
const toast = vi.fn();
const refresh = vi.fn(async () => {});
const setBills = vi.fn();

const reply = (data: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => data }) as unknown as Response;

const props: any = {
  accounts: [], taxRates: [], invoices: [], paymentsReceived: [], paymentsMade: [], expenses: [],
  clients: [], suppliers: [], items: [], clientOrders: [], purchaseOrders: [],
  bills: BILLS,
  setBills,
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
  await act(async () => { root.render(<BillsTab {...props} />); });
  await settle();
}

const rowDeleteButtons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Delete BILL-"]'));
const rowDelete = (billNumber: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="Delete ${billNumber}"]`)!;
const buttonNamed = (label: string) =>
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);
const openViewer = async (billNumber: string) => {
  const cell = Array.from(document.querySelectorAll('td')).find((td) => td.textContent === billNumber)!;
  await act(async () => { cell.click(); });
  await settle();
};
const click = async (el: HTMLElement) => {
  await act(async () => { el.click(); });
  await settle();
};
const deletes = () => calls.filter((c) => c.method === 'DELETE');
// Money is formatted with a non-breaking space as the thousands separator.
const plain = (s: string) => s.replace(/ /g, ' ');

beforeEach(() => {
  calls = [];
  impacts = {};
  deleteReply = { status: 200, body: { ok: true, ledgerReversed: true, voidedPayments: [] } };
  confirmAnswer = true;
  confirms = [];
  toast.mockClear();
  refresh.mockClear();
  setBills.mockClear();
  setConfirmHandler(async (opts) => { confirms.push(opts); return confirmAnswer; });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || 'GET').toUpperCase();
    calls.push({ method, url });
    const impact = url.match(/^\/api\/bills\/(\d+)\/delete-impact$/);
    if (impact && method === 'GET') {
      const id = Number(impact[1]);
      const scripted = impacts[id];
      return scripted ? reply(scripted.body, scripted.status) : reply(impactFor(id));
    }
    const one = url.match(/^\/api\/bills\/(\d+)$/);
    if (one && method === 'GET') return reply({ ...BILLS.find((b) => b.id === Number(one[1])), items: [] });
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

describe('Bills — admin', () => {
  it('has a delete button on every row, whatever the status', async () => {
    await renderAs('admin');

    expect(rowDeleteButtons().map((b) => b.getAttribute('aria-label'))).toEqual([
      'Delete BILL-2026-0005', 'Delete BILL-2026-0002', 'Delete BILL-2026-0008', 'Delete BILL-2026-0009',
    ]);
  });

  it('spells out what goes with a paid bill, then deletes it', async () => {
    impacts[5] = { status: 200, body: impactFor(5, {
      hasReceipt: true,
      payments: [{ paymentNumber: 'PMT-2026-0005', amount: 3441.38 }],
      stockKept: [{ partNumber: 'XY-CC211-3P-I-1C', quantity: 30 }],
    }) };
    deleteReply = { status: 200, body: { ok: true, ledgerReversed: true, voidedPayments: [{ paymentNumber: 'PMT-2026-0005', amount: 3441.38 }] } };
    await renderAs('admin');

    await click(rowDelete('BILL-2026-0005'));

    expect(confirms).toHaveLength(1);
    expect(confirms[0].title).toBe('Delete bill');
    expect(confirms[0].destructive).toBe(true);
    expect(confirms[0].confirmLabel).toBe('Delete bill and payment');
    expect(plain(confirms[0].message).split('\n\n')).toEqual([
      'Delete BILL-2026-0005? It is PAID, and this cannot be undone.',
      'A reversing entry dated today cancels it out in the ledger, and it comes off the VAT201 for its period.',
      'Payment PMT-2026-0005 (R3 441.38) was recorded against it. That payment is reversed and removed as well.',
      'Stock it booked in stays in inventory: 30 × XY-CC211-3P-I-1C. Adjust it under Items & Inventory if those goods never arrived.',
      'Its scanned receipt is deleted with it.',
    ]);
    // The preview is fetched first; the delete only goes out after the confirmation.
    expect(calls).toEqual([
      { method: 'GET', url: '/api/bills/5/delete-impact' },
      { method: 'DELETE', url: '/api/bills/5' },
    ]);
    expect(toast).toHaveBeenCalledWith('BILL-2026-0005 deleted, along with PMT-2026-0005.');
    expect(refresh).toHaveBeenCalledTimes(1);
    // The row is dropped from the list straight away.
    expect(setBills).toHaveBeenCalledTimes(1);
    expect(setBills.mock.calls[0][0](BILLS).map((b: any) => b.billNumber)).toEqual(['BILL-2026-0002', 'BILL-2026-0008', 'BILL-2026-0009']);
  });

  it('names every payment when the bill was paid in parts', async () => {
    impacts[5] = { status: 200, body: impactFor(5, {
      payments: [{ paymentNumber: 'PMT-2026-0005', amount: 3000 }, { paymentNumber: 'PMT-2026-0006', amount: 441.38 }],
    }) };
    deleteReply = { status: 200, body: { ok: true, ledgerReversed: true, voidedPayments: [{ paymentNumber: 'PMT-2026-0005', amount: 3000 }, { paymentNumber: 'PMT-2026-0006', amount: 441.38 }] } };
    await renderAs('admin');

    await click(rowDelete('BILL-2026-0005'));

    expect(confirms[0].confirmLabel).toBe('Delete bill and payments');
    expect(plain(confirms[0].message)).toContain(
      'Payments PMT-2026-0005 (R3 000.00) and PMT-2026-0006 (R441.38) were recorded against it. Those payments are reversed and removed as well.'
    );
    expect(toast).toHaveBeenCalledWith('BILL-2026-0005 deleted, along with PMT-2026-0005 and PMT-2026-0006.');
  });

  it('deletes nothing when the confirmation is declined', async () => {
    confirmAnswer = false;
    await renderAs('admin');

    await click(rowDelete('BILL-2026-0005'));

    expect(confirms).toHaveLength(1);
    expect(deletes()).toEqual([]);
    expect(setBills).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('tells an unpaid posted bill apart: ledger reversed, no payment', async () => {
    await renderAs('admin');

    await click(rowDelete('BILL-2026-0008'));

    expect(confirms[0].confirmLabel).toBe('Delete');
    expect(confirms[0].message).toBe(
      'Delete BILL-2026-0008? It is AWAITING PAYMENT, and this cannot be undone.\n\n' +
      'A reversing entry dated today cancels it out in the ledger, and it comes off the VAT201 for its period.'
    );
    expect(toast).toHaveBeenCalledWith('BILL-2026-0008 deleted.');
  });

  it('says a void bill leaves the ledger alone', async () => {
    await renderAs('admin');

    await click(rowDelete('BILL-2026-0002'));

    expect(confirms[0].title).toBe('Delete bill');
    expect(confirms[0].message).toBe(
      'Delete BILL-2026-0002? It is VOID, and this cannot be undone.\n\n' +
      'The ledger is not affected: the bill was already reversed when it was voided.'
    );
    expect(deletes()).toEqual([{ method: 'DELETE', url: '/api/bills/2' }]);
  });

  it('keeps the draft confirmation short', async () => {
    await renderAs('admin');

    await click(rowDelete('BILL-2026-0009'));

    expect(confirms[0].title).toBe('Delete draft bill');
    expect(confirms[0].message).toBe('Delete draft BILL-2026-0009? This cannot be undone.');
  });

  it('explains why a bill cannot be deleted yet, and does not try', async () => {
    const reason = 'Payment PMT-2026-0005 also pays BILL-2026-0008, so it cannot be removed along with this bill. Void that payment under Purchases > Payments Made first, then delete the bill.';
    impacts[5] = { status: 200, body: impactFor(5, { payments: [{ paymentNumber: 'PMT-2026-0005', amount: 3441.38 }], blockers: [reason] }) };
    await renderAs('admin');

    // The notice has a single OK button, which resolves true like a confirm
    // would. That must not be taken as consent to delete.
    await click(rowDelete('BILL-2026-0005'));

    expect(confirms).toEqual([{ title: 'BILL-2026-0005 cannot be deleted yet', message: reason, confirmLabel: 'OK', hideCancel: true }]);
    expect(deletes()).toEqual([]);
    expect(toast).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('does not ask, or delete, if the preview cannot be loaded', async () => {
    impacts[5] = { status: 500, body: { error: 'database unavailable' } };
    await renderAs('admin');

    await click(rowDelete('BILL-2026-0005'));

    expect(confirms).toEqual([]);
    expect(deletes()).toEqual([]);
    expect(toast).toHaveBeenCalledWith('database unavailable', 'ERROR');
  });

  it('shows the server’s reason when the delete is refused, and keeps the row', async () => {
    deleteReply = { status: 409, body: { error: 'This bill is part of landed cost batch LC-2026-0002. Delete that batch under Purchases > Landed Cost first.' } };
    await renderAs('admin');

    await click(rowDelete('BILL-2026-0005'));

    expect(toast).toHaveBeenCalledWith('This bill is part of landed cost batch LC-2026-0002. Delete that batch under Purchases > Landed Cost first.', 'ERROR');
    expect(setBills).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('can delete from the viewer of a paid bill too', async () => {
    await renderAs('admin');
    await openViewer('BILL-2026-0005');

    await click(buttonNamed('Delete')!);

    expect(confirms[0].message).toContain('Delete BILL-2026-0005? It is PAID');
    expect(deletes()).toEqual([{ method: 'DELETE', url: '/api/bills/5' }]);
  });

  it('lets the buttons be used again afterwards', async () => {
    confirmAnswer = false;
    await renderAs('admin');

    await click(rowDelete('BILL-2026-0005'));

    expect(rowDeleteButtons().every((b) => !b.disabled)).toBe(true);
  });
});

describe('Bills — ordinary user', () => {
  it('has no delete buttons on the list', async () => {
    await renderAs('user');

    expect(rowDeleteButtons()).toEqual([]);
  });

  it('is offered Delete in the viewer for a draft only', async () => {
    await renderAs('user');

    for (const billNumber of ['BILL-2026-0005', 'BILL-2026-0002', 'BILL-2026-0008']) {
      await openViewer(billNumber);
      expect(buttonNamed('Delete'), billNumber).toBeUndefined();
      await click(document.querySelector<HTMLButtonElement>('button[aria-label="Close modal"]')!);
    }

    await openViewer('BILL-2026-0009');
    expect(buttonNamed('Delete')).toBeDefined();
  });

  it('can still void an unpaid bill from the viewer', async () => {
    await renderAs('user');

    await openViewer('BILL-2026-0008');

    expect(buttonNamed('Void')).toBeDefined();
    expect(buttonNamed('Pay Bill')).toBeDefined();
  });
});
