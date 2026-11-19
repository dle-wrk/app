import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StockPlacesView, { codePrefix, groupLocations } from './views/StockPlacesView';
import { setConfirmHandler } from '../lib/confirmDialog';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement; let root: Root; let posted: any[];
beforeEach(() => {
  posted = [];
  localStorage.setItem('currentUser', JSON.stringify({ role: 'admin' }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { posted.push(JSON.parse(String(init.body))); return { ok: true, json: async () => ({ id: 1 }) } as any; }
    return { ok: true, json: async () => ({ locations: [], unplaced: { units: 0, items: 0 } }) } as any;
  }));
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const type = (el: HTMLInputElement, v: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});

describe('a location code', () => {
  it('offers the stock codes, fills the name from the one picked, and takes anything typed', async () => {
    const items: any[] = [{ partNumber: 'CAP-024', name: '100NF' }, { partNumber: 'LED-005', name: 'LED' }];
    await act(async () => { root.render(<StockPlacesView triggerToast={() => {}} items={items} />); });
    await act(async () => { [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('New location'))!.click(); });
    expect([...host.querySelectorAll('#location-code-options option')].map((o) => (o as HTMLOptionElement).value)).toEqual(['CAP-024', 'LED-005']);
    const code = host.querySelector('input[aria-label="Location code"]') as HTMLInputElement;
    const name = () => (host.querySelector('input[aria-label="Location name"]') as HTMLInputElement).value;
    type(code, 'CAP-024');
    expect(name()).toBe('100NF');
    type(code, 'REEL TOWER 2'); // typed freely: kept, and the name already given isn't changed
    expect([code.value, name()]).toEqual(['REEL TOWER 2', '100NF']);
    await act(async () => { [...host.querySelectorAll('button')].find((b) => b.textContent === 'Add')!.click(); });
    expect(posted).toEqual([{ code: 'REEL TOWER 2', name: '100NF', notes: '', category: '' }]);
  });
});

describe('grouping locations', () => {
  const locs = [
    { code: 'ANT-002', category: null }, { code: 'A1-03', category: 'Bins' }, { code: 'REEL-RACK-2', category: 'Reel racks' },
    { code: 'ANT-001', category: '  ' }, { code: 'ASS-004', category: 'Bins' }, { code: '12-B', category: null },
  ];
  it('by category: A to Z, "No category" last, blank counts as none, order kept inside a group', () => {
    expect(groupLocations(locs, 'category').map((g) => [g.key, g.items.map((l) => l.code)])).toEqual([
      ['Bins', ['A1-03', 'ASS-004']], ['Reel racks', ['REEL-RACK-2']], ['No category', ['ANT-002', 'ANT-001', '12-B']],
    ]);
  });
  it('by code prefix: the letters before the first dash or digit', () => {
    expect(['ANT-001', 'a1-03', 'REEL-RACK-2', '12-B', ' cap024 '].map(codePrefix)).toEqual(['ANT', 'A', 'REEL', '#', 'CAP']);
    expect(groupLocations(locs, 'prefix').map((g) => g.key)).toEqual(['#', 'A', 'ANT', 'ASS', 'REEL']);
    expect(groupLocations(locs, 'none')).toEqual([{ key: '', items: locs }]);
  });
});

describe('the locations list', () => {
  const LOCS = [
    { id: 1, code: 'ANT-001', name: 'FIBERGLASS', notes: null, category: 'Antenna bins', active: true, items: 1, units: 200, item_serial: null, item_name: null, item_stock: null, item_unplaced: null },
    { id: 2, code: 'ANT-002', name: 'TCU', notes: null, category: 'Antenna bins', active: true, items: 1, units: 100, item_serial: null, item_name: null, item_stock: null, item_unplaced: null },
    { id: 3, code: 'RR-1', name: 'Reel rack 1', notes: null, category: null, active: true, items: 0, units: 0, item_serial: null, item_name: null, item_stock: null, item_unplaced: null },
  ];
  let calls: { url: string; method: string; body: any }[];
  beforeEach(() => {
    calls = [];
    localStorage.removeItem('locationsGroupBy');
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method || 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (method === 'DELETE') return { ok: true, json: async () => ({ ok: true, unitsToNoLocation: 200 }) } as any;
      if (method === 'POST') return { ok: true, json: async () => ({ ok: true, updated: 2 }) } as any;
      return { ok: true, json: async () => ({ locations: LOCS, unplaced: { units: 0, items: 0 } }) } as any;
    }));
    setConfirmHandler(async () => true);
  });
  const btn = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text || b.getAttribute('aria-label') === text) as HTMLButtonElement;
  const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

  it('groups by category, folds a group, and offers delete on a location that holds stock', async () => {
    await act(async () => { root.render(<StockPlacesView triggerToast={() => {}} items={[]} />); });
    await settle();
    const headers = () => [...host.querySelectorAll('tr[aria-expanded]')].map((r) => r.textContent);
    expect(headers().map((t) => t?.match(/^[A-Za-z ]+?(?=\d)/)?.[0])).toEqual(['Antenna bins', 'No category']);
    expect(btn('Delete ANT-001')).toBeTruthy(); // holds 200 units, still offered
    await act(async () => { (host.querySelector('tr[aria-expanded]') as HTMLElement).click(); });
    expect(host.querySelector('[data-location="ANT-001"]')).toBeNull();
    expect(host.querySelector('[data-location="RR-1"]')).not.toBeNull();
    await act(async () => { btn('Delete RR-1').click(); });
    await settle();
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual(['/api/stock-locations/3']);
  });

  it('puts the selected locations in a category in one go', async () => {
    await act(async () => { root.render(<StockPlacesView triggerToast={() => {}} items={[]} />); });
    await settle();
    await act(async () => { (host.querySelector('input[aria-label="Select every location in Antenna bins"]') as HTMLInputElement).click(); });
    expect(host.querySelector('[data-testid="location-bulk"]')?.textContent).toContain('2 selected');
    type(host.querySelector('input[aria-label="Category for the selected locations"]') as HTMLInputElement, 'Antennas');
    await act(async () => { btn('Set category').click(); });
    await settle();
    expect(calls.find((c) => c.url === '/api/stock-locations/set-category')?.body).toEqual({ ids: [1, 2], category: 'Antennas' });
  });

  it('moves the stock in the selected locations to another location', async () => {
    const toasts: string[] = [];
    await act(async () => { root.render(<StockPlacesView triggerToast={(m) => { toasts.push(m); }} items={[]} />); });
    await settle();
    await act(async () => { (host.querySelector('input[aria-label="Select every location in Antenna bins"]') as HTMLInputElement).click(); });
    // The target list offers the other locations, not the ones being emptied.
    expect([...host.querySelectorAll('#move-to-options option')].map((o) => (o as HTMLOptionElement).value)).toEqual(['RR-1']);
    type(host.querySelector('input[aria-label="Move the stock in the selected locations to"]') as HTMLInputElement, 'antenna shelf');
    await act(async () => { (host.querySelector('[data-testid="location-bulk"] input[type="checkbox"]') as HTMLInputElement).click(); });
    await act(async () => { btn('Move stock').click(); });
    await settle();
    expect(calls.find((c) => c.url === '/api/stock-locations/move-contents')?.body).toEqual({ ids: [1, 2], to: 'ANTENNA-SHELF', deactivate: true });
  });
});