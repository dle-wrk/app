import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DispatchTab } from './DispatchTab';

// Drives the real DispatchTab with a stubbed API, the way a user arrives
// from a sales order's "Create Delivery / Collection Note" button.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ORDER_ID = 8;
// Shaped like GET /api/client-order-items: quantities arrive as text.
const ORDER_LINES = [
  { id: 21, clientOrderId: ORDER_ID, partNumber: 'BAT-002', description: '4Ah Li-Ion Battery backup', quantity: '2.00' },
  { id: 22, clientOrderId: ORDER_ID, partNumber: 'PSU-002', description: '24VDC 1.8A(40W) REGULATED POWER SUPPLY', quantity: '1.00' },
  // A free-typed SKU that is in neither pick-list.
  { id: 23, clientOrderId: ORDER_ID, partNumber: 'REPAIR', description: 'REPAIR', quantity: '1.00' },
  { id: 99, clientOrderId: 5, partNumber: 'OTHER-001', description: 'Line of a different order', quantity: '4.00' },
];

type Call = { method: string; url: string; body?: any };
let calls: Call[];
let orderItemsStatus: number;
const toast = vi.fn();

const reply = (data: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => data }) as unknown as Response;

const moduleData: any = {
  accounts: [], taxRates: [], invoices: [], paymentsReceived: [], purchaseOrders: [], bills: [],
  paymentsMade: [], expenses: [], suppliers: [],
  clients: [{ id: 30, clientName: 'Lumax Energy', status: 'ACTIVE', createdAt: '' }],
  clientOrders: [{ id: ORDER_ID, clientId: 30, orderNumber: 'QUO-2026-0006', orderDate: '2026-09-30', status: 'QUOTATION', currency: 'ZAR' }],
  items: [
    { partNumber: 'BAT-002', name: '4Ah Li-Ion Battery backup' },
    { partNumber: 'PSU-002', name: '24VDC power supply' },
  ],
  triggerToast: toast,
  refresh: async () => {},
};

let host: HTMLDivElement;
let root: Root;

const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

async function render(prefill: { orderId: number; noteType: 'DELIVERY' | 'COLLECTION' } | null) {
  const consumed = vi.fn();
  await act(async () => {
    root.render(<DispatchTab {...moduleData} prefillFromOrder={prefill} onPrefillConsumed={consumed} />);
  });
  await settle();
  return consumed;
}

const headings = () => Array.from(document.querySelectorAll('h4')).map((h) => h.textContent);
const button = (label: string) =>
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === label) as HTMLButtonElement;
const lineRows = () =>
  Array.from(document.querySelectorAll<HTMLInputElement>('input[placeholder="Item description"]')).map((desc) => {
    const tr = desc.closest('tr')!;
    return {
      part: tr.querySelector('select')!.value,
      description: desc.value,
      quantity: tr.querySelector<HTMLInputElement>('input[type="number"]')!.value,
      bookOut: tr.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked,
    };
  });

beforeEach(() => {
  calls = [];
  orderItemsStatus = 200;
  toast.mockClear();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || 'GET').toUpperCase();
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === 'GET' && url.startsWith('/api/dispatch-notes')) return reply([]);
    if (method === 'GET' && url === '/api/production-products') return reply([]);
    if (method === 'GET' && url === '/api/client-order-items') {
      return orderItemsStatus === 200 ? reply(ORDER_LINES) : reply({ error: 'boom' }, orderItemsStatus);
    }
    if (method === 'POST' && url === '/api/dispatch-notes') return reply({ id: 1, noteNumber: 'DN-2026-0009' }, 201);
    return reply({ error: `unexpected ${method} ${url}` }, 500);
  }));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('DispatchTab — note started from a sales order', () => {
  it('opens a new delivery note already holding the order’s lines', async () => {
    const consumed = await render({ orderId: ORDER_ID, noteType: 'DELIVERY' });

    expect(headings()).toContain('New Delivery Note');
    expect(document.body.textContent).not.toContain('Edit undefined');
    expect(lineRows()).toEqual([
      { part: 'BAT-002', description: '4Ah Li-Ion Battery backup', quantity: '2', bookOut: false },
      { part: 'PSU-002', description: '24VDC 1.8A(40W) REGULATED POWER SUPPLY', quantity: '1', bookOut: false },
      { part: 'REPAIR', description: 'REPAIR', quantity: '1', bookOut: false },
    ]);
    expect(toast).toHaveBeenCalledWith('Prefilled 3 item(s) from the order.', 'INFO');
    expect(consumed).toHaveBeenCalledTimes(1);
  });

  it('does the same for a collection note', async () => {
    await render({ orderId: ORDER_ID, noteType: 'COLLECTION' });

    expect(headings()).toContain('New Collection Note');
    expect(lineRows().map((r) => r.part)).toEqual(['BAT-002', 'PSU-002', 'REPAIR']);
  });

  it('saves it as a new note rather than updating one that does not exist', async () => {
    await render({ orderId: ORDER_ID, noteType: 'DELIVERY' });

    await act(async () => { button('Save Draft').click(); });
    await settle();

    const writes = calls.filter((c) => c.method !== 'GET');
    expect(writes).toHaveLength(1);
    expect(writes[0].method).toBe('POST');
    expect(writes[0].url).toBe('/api/dispatch-notes');
    expect(writes[0].body).toMatchObject({ noteType: 'DELIVERY', clientId: 30, clientOrderId: ORDER_ID, status: 'DRAFT' });
    expect(writes[0].body.items).toEqual([
      { partNumber: 'BAT-002', description: '4Ah Li-Ion Battery backup', quantity: 2, deductStock: false },
      { partNumber: 'PSU-002', description: '24VDC 1.8A(40W) REGULATED POWER SUPPLY', quantity: 1, deductStock: false },
      { partNumber: 'REPAIR', description: 'REPAIR', quantity: 1, deductStock: false },
    ]);
  });

  it('says so when the order’s items cannot be loaded', async () => {
    orderItemsStatus = 500;
    await render({ orderId: ORDER_ID, noteType: 'DELIVERY' });

    expect(headings()).toContain('New Delivery Note');
    expect(lineRows()).toEqual([{ part: '', description: '', quantity: '1', bookOut: false }]);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("Couldn't load the order's items"), 'ERROR');
  });
});

describe('DispatchTab — note started from the list', () => {
  it('opens an empty new note and does not fetch any order lines', async () => {
    await render(null);
    expect(lineRows()).toEqual([]);

    await act(async () => { button('New Delivery Note').click(); });
    await settle();

    expect(headings()).toContain('New Delivery Note');
    expect(lineRows()).toEqual([{ part: '', description: '', quantity: '1', bookOut: false }]);
    expect(calls.some((c) => c.url === '/api/client-order-items')).toBe(false);
  });
});
