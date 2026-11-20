import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BillInbox, FillMissingModal } from './bookkeeping/BillInbox';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const jpeg = 'data:image/jpeg;base64,AAAA';
const scan = {
  id: 4, status: 'INBOX', pageCount: 2, thumb: jpeg, note: 'for PO-31', user: { id: 1, name: 'Sam' }, capturedAt: '2026-11-19T08:00:00Z', createdAt: '2026-11-19T08:00:00Z',
  read: { status: 'READ', error: null, at: null }, billId: null, billNumber: null, warnings: ['VAT is charged but no supplier VAT number was found.'],
  ocr: { supplier: 'Mouser Electronics', supplierVatNumber: null, invoiceNumber: 'INV-88123', date: '2026-11-10', dueDate: null, total: 1150, currency: 'ZAR', poNumber: null, lineItems: [{ description: 'Cap', partNumber: 'X', quantity: 1, unitPrice: 1000, lineTotal: 1000 }] },
  match: { supplier: { id: '1', name: 'Mouser', by: 'name' }, po: null, dueDate: '2026-12-10', lines: [{ partNumber: 'X', item: 'CAP-024' }] },
};

let host: HTMLDivElement; let root: Root; let calls: { method: string; url: string; body: any }[];
beforeEach(() => {
  calls = [];
  localStorage.setItem('currentUser', JSON.stringify({ role: 'admin' }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method || 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
    const ok = (d: unknown) => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => d, text: async () => JSON.stringify(d) });
    if (url.startsWith('/api/bill-scans?')) return ok({ items: [scan], ocr: true });
    if (url === '/api/bill-scans/4') return ok({ ...scan, pages: [jpeg, jpeg] });
    if (url === '/api/bills/inbox/4/attach') return ok({ billNumber: 'BILL-2026-0003', pages: 3, invoiceNumber: 'INV-88123' });
    if (url === '/api/bills/7/read-missing') return ok({ billId: 7, billNumber: 'BILL-2026-0007', supplier: { id: '1', name: 'Mouser' }, proposals: [{ key: 'vatNumber', target: 'supplier', label: 'VAT number', current: null, value: '4123456789' }, { key: 'supplierInvoiceNumber', target: 'bill', label: 'Supplier invoice number', current: null, value: 'INV-7' }], warnings: [],
      ocr: { supplier: 'HD Cabling', supplierVatNumber: '4123456789', invoiceNumber: 'SO-16907', date: '2026-11-10', total: 174, taxTotal: 22.7, currency: 'ZAR', lineItems: [] } });
    if (url === '/api/bills/7/fill-missing') return ok({ billNumber: 'BILL-2026-0007', filled: ['vatNumber'] });
    return ok({});
  }));
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); localStorage.removeItem('currentUser'); });
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
const btn = (re: RegExp) => [...host.querySelectorAll('button')].find(b => re.test(b.textContent || '')) as HTMLButtonElement;

describe('bills from the scanner', () => {
  const bills: any[] = [{ id: 3, billNumber: 'BILL-2026-0003', supplierName: 'Mouser', status: 'DRAFT', receiptImage: null }];

  it('lists each with what was read and matched, and creates a bill from it filled in', async () => {
    const onCreate = vi.fn();
    await act(async () => { root.render(<BillInbox bills={bills} triggerToast={() => {}} onCreateBill={onCreate} onChanged={() => {}} />); });
    await settle();
    const text = host.querySelector('[data-testid="bill-inbox"]')!.textContent!;
    expect(text).toContain('Mouser Electronics');
    expect(text).toContain('→ Mouser');
    expect(text).toContain('Invoice INV-88123');
    expect(text).toContain('no supplier VAT number');
    await act(async () => { btn(/Create bill/).click(); });
    await settle();
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ billScanId: 4, supplierId: '1', supplierInvoiceNumber: 'INV-88123', dueDate: '2026-12-10', receiptImage: JSON.stringify([jpeg, jpeg]) }));
    expect(onCreate.mock.calls[0][0].lineItems[0].partNumber).toBe('CAP-024');
  });

  it('attaches one to an existing bill', async () => {
    const toast = vi.fn(); const changed = vi.fn();
    await act(async () => { root.render(<BillInbox bills={bills} triggerToast={toast} onCreateBill={() => {}} onChanged={changed} />); });
    await settle();
    const sel = host.querySelector('select[aria-label="Bill to attach it to"]') as HTMLSelectElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(sel, '3'); sel.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { btn(/^\s*Attach\s*$/).click(); });
    await settle();
    expect(calls.find(c => c.url === '/api/bills/inbox/4/attach')?.body).toEqual({ billId: 3 });
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('Attached to BILL-2026-0003 (3 pages), supplier invoice INV-88123 filled in'));
    expect(changed).toHaveBeenCalled();
    expect(host.querySelector('[data-testid="bill-inbox"]')).toBeNull(); // the last one left the list
  });
});

describe('filling in what existing bills miss', () => {
  it('reads the bills with photos, offers what is missing, and fills only what stays ticked', async () => {
    const done = vi.fn();
    const bills: any[] = [{ id: 7, billNumber: 'BILL-2026-0007', status: 'PAID', receiptImage: jpeg }, { id: 8, billNumber: 'BILL-2026-0008', status: 'PAID', receiptImage: null }];
    await act(async () => { root.render(<FillMissingModal bills={bills} supplierName={() => 'Mouser'} onClose={() => {}} onDone={done} triggerToast={() => {}} />); });
    expect(host.textContent).toContain('1 bill has photos attached');
    await act(async () => { btn(/Read 1 bill/).click(); });
    await settle();
    const results = host.querySelector('[data-testid="fill-missing-results"]')!;
    expect(results.textContent).toContain('4123456789');
    expect(results.textContent).toContain('INV-7');
    const boxes = [...results.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    expect(boxes.map(b => b.checked)).toEqual([true, true]);
    await act(async () => { boxes[1].click(); }); // keep the VAT number only
    await act(async () => { btn(/Fill in 1 of 2/).click(); });
    await settle();
    expect(calls.find(c => c.url === '/api/bills/7/fill-missing')?.body).toEqual({ values: { vatNumber: '4123456789' } });
    expect(calls.some(c => c.url === '/api/bills/8/read-missing')).toBe(false);
    expect(done).toHaveBeenCalled();
  });
});

describe("one bill's Read button", () => {
  it('reads that bill at once and shows what the invoice says, with what is missing', async () => {
    const bills: any[] = [{ id: 7, billNumber: 'BILL-2026-0007', status: 'PAID', receiptImage: jpeg }];
    await act(async () => { root.render(<FillMissingModal bills={bills} autoStart supplierName={() => 'HD Cabling'} onClose={() => {}} onDone={() => {}} triggerToast={() => {}} />); });
    await settle();
    expect(calls.filter(c => c.url === '/api/bills/7/read-missing')).toHaveLength(1);
    expect(host.textContent).toContain('Read BILL-2026-0007');
    const summary = host.querySelector('[data-testid="read-summary"]')!.textContent!;
    expect(summary).toContain('HD Cabling');
    expect(summary).toContain('invoice SO-16907');
    expect(summary).toContain('VAT 4123456789');
    expect(btn(/Fill in 2 of 2/)).toBeTruthy();
    // A poor read: read the invoice again; the row is replaced, not added.
    await act(async () => { btn(/^\s*Read again\s*$/).click(); });
    await settle();
    expect(calls.filter(c => c.url === '/api/bills/7/read-missing')).toHaveLength(2);
    expect(host.querySelectorAll('[data-testid="read-summary"]')).toHaveLength(1);
    expect(btn(/Fill in 2 of 2/)).toBeTruthy();
  });
});
