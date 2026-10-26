import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StockPlacesView from './views/StockPlacesView';

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
    expect(posted).toEqual([{ code: 'REEL TOWER 2', name: '100NF', notes: '' }]);
  });
});
