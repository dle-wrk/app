import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ItemDetailModal from './ItemDetailModal';

// Adding a supplier link in the item form: a checklist of what to fill in.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const DETAILS = {
  supplier: 'lcsc', supplierName: 'LCSC', supplierPartNumber: 'C365814', manufacturerPartNumber: 'FM31X104K251EEG', manufacturer: 'PSA',
  description: '100nF ±10% 250V Ceramic Capacitor X7R 1206', value: '100nF', tolerance: '±10%', package: '1206',
  datasheet: 'https://datasheet.lcsc.com/x.pdf', extra: [{ name: 'Voltage Rating', value: '250V' }],
};
const LINK = 'https://www.lcsc.com/product-detail/Multilayer-Ceramic-Capacitors_PSA-FM31X104K251EEG_C365814.html';

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ url: string; body: any }>;
beforeEach(() => {
  calls = [];
  localStorage.setItem('currentUser', JSON.stringify({ role: 'engineer' }));
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return { ok: true, status: 200, json: async () => ({ details: DETAILS, note: null }) } as unknown as Response;
  }));
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const field = (name: string) => host.querySelector(`[name="${name}"]`) as HTMLInputElement;
const button = (text: RegExp) => [...host.querySelectorAll('button')].find((b) => text.test(b.textContent ?? '')) as HTMLButtonElement;

describe('filling an item from a supplier link', () => {
  it('lists what the product has, fills in the ticked lines, and can be undone', async () => {
    const onSave = vi.fn();
    const item = { partNumber: 'CAP-024', name: '100nF', description: '', manufacturer: 'Generic', supplier: 'N/A', stockLevel: 1, price: 0, category: 'Capacitors',
      status: 'ACTIVE', value: '', tolerance: '', packageName: '0603', size: '', datasheet: '' } as any;
    await act(async () => { root.render(<ItemDetailModal item={item} onClose={() => {}} onSave={onSave} />); });
    await act(async () => { (document.getElementById('btn-edit-item') as HTMLButtonElement).click(); });

    const link = field('weblinks_0');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(link, LINK);
      link.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { link.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    await settle();
    expect(calls).toEqual([{ url: '/api/pricing/link-lookup', body: { url: LINK } }]);

    const list = host.querySelector('[data-testid="link-choices"]')!;
    const boxes = [...list.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    const labelled = (l: string) => boxes.find((b) => b.getAttribute('aria-label') === `Fill ${l}`)!;
    expect(labelled('Package').checked).toBe(false); // the item has 0603
    expect(list.textContent).toContain('Replaces 0603');
    expect(labelled('Value').checked).toBe(true);
    expect(list.textContent).toContain('Voltage Rating 250V');

    await act(async () => { labelled('Datasheet').click(); }); // untick
    await act(async () => { button(/^Fill \d+ selected$/).click(); });
    expect(field('value').value).toBe('100nF');
    expect(field('tolerance').value).toBe('±10%');
    expect(field('datasheet')?.value ?? '').toBe('');
    expect(field('supPns_2').value).toBe('C365814');
    expect(field('manPns_0').value).toBe('FM31X104K251EEG');
    expect(host.querySelector('[data-testid="link-notice"]')!.textContent).toContain('Filled from LCSC');

    await act(async () => { button(/^Undo$/).click(); });
    expect(field('value').value).toBe('');
    expect(field('supPns_2').value).toBe('');
  });
});
