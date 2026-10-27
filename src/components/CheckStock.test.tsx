import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StockPlacesView from './views/StockPlacesView';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('../lib/confirmDialog', () => ({ confirmDialog: async () => true }));

let host: HTMLDivElement; let root: Root; let calls: Array<{ method: string; url: string; body: any }>;
const LINES = [
  { id: 1, serial_number: 'ANT-001', name: 'FIBERGLASS', location_code: 'ANT-001', lot: null, expected: 200, now: 200, counted: null, note: null, added: false, bin_id: 5 },
  { id: 2, serial_number: 'CAP-024', name: '100NF', location_code: null, lot: null, expected: 1800, now: 1800, counted: null, note: null, added: false, bin_id: null },
];
beforeEach(() => {
  calls = [];
  localStorage.setItem('currentUser', JSON.stringify({ role: 'admin' }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
    const ok = (b: any) => ({ ok: true, json: async () => b }) as any;
    if (url === '/api/stock-counts' && method === 'GET') return ok([]);
    if (url === '/api/stock-counts' && method === 'POST') return ok({ id: 7, number: 'SC-2026-0002' });
    if (url === '/api/stock-counts/7' && method === 'GET') return ok({ count: { id: 7, number: 'SC-2026-0002', scope: 'items', location_code: null, prefix: null, status: 'OPEN' }, lines: LINES });
    if (url === '/api/stock-counts/7/post') return ok({ number: 'SC-2026-0002', items: [{ serialNumber: 'CAP-024', change: -20 }] });
    if (url.startsWith('/api/stock-locations')) return ok({ locations: [], unplaced: { units: 0, items: 0 } });
    return ok({ ok: true });
  }));
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const type = (el: HTMLInputElement, v: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;

describe('Check stock', () => {
  it('checks chosen items: each line starts at the system amount, change only what differs, one Confirm', async () => {
    const items: any[] = [{ partNumber: 'ANT-001', name: 'FIBERGLASS' }, { partNumber: 'CAP-024', name: '100NF' }];
    await act(async () => { root.render(<StockPlacesView triggerToast={() => {}} items={items} />); });
    await act(async () => { button('Check stock').click(); });
    await act(async () => { button('Some items').click(); });
    const pick = host.querySelector('input[aria-label="Item to check"]') as HTMLInputElement;
    type(pick, 'ant-001'); type(pick, 'CAP-024'); // picked as typed, any case
    expect([...host.querySelectorAll('[data-testid="count-form"] span.font-mono')].map((s) => s.textContent?.replace('×', ''))).toEqual(['ANT-001', 'CAP-024']);
    await act(async () => { button('Check').click(); });
    expect(calls.find((c) => c.method === 'POST' && c.url === '/api/stock-counts')!.body).toMatchObject({ scope: 'items', serials: ['ANT-001', 'CAP-024'] });

    // Lines start at what the system says
    const input = (s: string) => host.querySelector(`input[aria-label="Actually there ${s}"]`) as HTMLInputElement;
    expect([input('ANT-001').value, input('CAP-024').value]).toEqual(['200', '1800']);
    type(input('CAP-024'), '1780');
    expect(host.querySelector('[data-count-line="CAP-024"]')!.textContent).toContain('-20');
    await act(async () => { button('Confirm').click(); });
    const saved = calls.find((c) => c.method === 'PUT' && c.url === '/api/stock-counts/7/lines')!.body.lines;
    expect(saved).toEqual([{ id: 1, counted: '200' }, { id: 2, counted: '1780' }]); // every line, so a match counts as checked
    expect(calls.some((c) => c.url === '/api/stock-counts/7/post')).toBe(true);
  });
});
