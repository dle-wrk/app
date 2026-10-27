import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StockScan from './StockScan';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement; let root: Root; let calls: Array<{ method: string; url: string; body: any }>;
const LOCATIONS = [
  { id: 1, code: 'A1-03', name: 'Shelf 3', active: true, items: 0, units: 0 },
  { id: 2, code: 'ANT-001', name: 'FIBERGLASS', active: true, items: 0, units: 0 },
];
let places: Record<string, any>;
beforeEach(() => {
  calls = [];
  places = {
    'CAP-024': { item: { serial_number: 'CAP-024', name: '100NF', stock: 1800 }, bins: [{ id: 9, location_id: 1, location_code: 'A1-03', lot: null, qty: 300 }], unplaced: 1500 },
    'ANT-001': { item: { serial_number: 'ANT-001', name: 'FIBERGLASS', stock: 200 }, bins: [], unplaced: 200 },
  };
  localStorage.setItem('currentUser', JSON.stringify({ role: 'admin' }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
    const ok = (b: any) => ({ ok: true, json: async () => b }) as any;
    if (url === '/api/stock-locations') return ok({ locations: LOCATIONS, unplaced: { units: 0, items: 0 } });
    const m = url.match(/^\/api\/inventory\/([^/]+)\/places$/);
    if (m) return ok(places[decodeURIComponent(m[1])]);
    if (url === '/api/stock-counts' && method === 'POST') return ok({ id: 12, number: 'SC-2026-0003' });
    return ok({ ok: true });
  }));
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const items: any[] = [{ partNumber: 'CAP-024', name: '100NF' }, { partNumber: 'ANT-001', name: 'FIBERGLASS' }];
const scanner = () => host.querySelector('input[aria-label="Scan"]') as HTMLInputElement;
/** What a scanner does: types the code, then Enter. */
const scan = async (code: string) => {
  const el = scanner();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, code);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
};
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;
const moves = () => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/places/move'));

describe('Scan', () => {
  it('a bin label, then an item: puts away what is not put away yet, Enter confirms', async () => {
    const onOpenCount = vi.fn();
    await act(async () => { root.render(<StockScan triggerToast={() => {}} items={items} onOpenCount={onOpenCount} />); });
    await scan('LOC:A1-03');
    expect(host.querySelector('[data-testid="scan-bin"]')!.textContent).toContain('A1-03');
    await scan('cap-024'); // any case
    const qty = host.querySelector('input[aria-label="How many into the bin"]') as HTMLInputElement;
    expect(qty.value).toBe('1500');
    expect(host.textContent).toContain('300 already here.');
    await act(async () => { qty.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(moves()).toHaveLength(1);
    expect(moves()[0]).toMatchObject({ url: '/api/inventory/CAP-024/places/move', body: { qty: 1500, fromBinId: null, toLocationId: 1 } });

    await act(async () => { button('Check this bin').click(); });
    expect(calls.find((c) => c.method === 'POST' && c.url === '/api/stock-counts')!.body).toMatchObject({ scope: 'location', locationId: 1 });
    expect(onOpenCount).toHaveBeenCalledWith(12);
  });

  it('an item with no bin scanned goes to the bin named after it', async () => {
    await act(async () => { root.render(<StockScan triggerToast={() => {}} items={items} />); });
    await scan('ANT-001');
    expect(host.querySelector('[data-testid="scan-bin"]')!.textContent).toContain('ANT-001');
    expect(button('Put away in ANT-001')).toBeTruthy();
  });

  it('an item with another bin and nothing left to put away offers a move from it', async () => {
    places['CAP-024'] = { ...places['CAP-024'], unplaced: 0 };
    await act(async () => { root.render(<StockScan triggerToast={() => {}} items={items} />); });
    await scan('LOC:ANT-001');
    await scan('CAP-024');
    expect((host.querySelector('select[aria-label="Scan move from"]') as HTMLSelectElement).value).toBe('9');
    await act(async () => { button('Move to ANT-001').click(); });
    expect(moves()[0].body).toMatchObject({ qty: 300, fromBinId: 9, toLocationId: 2 });
  });

  it('says so when nothing has the code', async () => {
    await act(async () => { root.render(<StockScan triggerToast={() => {}} items={items} />); });
    await scan('XYZ-999');
    expect(host.querySelector('[role="status"]')!.textContent).toBe('Nothing has the code XYZ-999.');
    await scan('LOC:NOPE');
    expect(host.querySelector('[role="status"]')!.textContent).toContain('There is no bin NOPE');
  });

  it('prints bin labels, or item labels starting with a prefix', async () => {
    const write = vi.fn();
    const win = { document: { open: vi.fn(), write, close: vi.fn() }, focus: vi.fn(), print: vi.fn() };
    vi.stubGlobal('open', vi.fn(() => win));
    await act(async () => { root.render(<StockScan triggerToast={() => {}} items={items} />); });
    expect(host.querySelector('[data-testid="labels"]')!.textContent).toContain('2 labels, 1 sheet');
    await act(async () => { button('Print').click(); });
    expect(write.mock.calls[0][0]).toContain('Barcode LOC:A1-03');
    expect(win.print).toHaveBeenCalled();
  });
});
