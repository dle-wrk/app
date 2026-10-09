import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductionCostsView } from './ProductionCostsView';

// The Production Costs catalogue: ascending by model number, with a search.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const product = (id: number, modelNumber: string, description: string, category: string) =>
  ({ id, modelNumber, description, category, productionCost: null, sellingPrice: 100, currency: 'ZAR', notes: '', margin: null, marginPct: null, createdAt: '' });
const PRODUCTS = [
  product(1, 'TCU-010-SAT', 'Tracker ten', 'TCU'),
  product(2, 'ANT-LORA-NCU', 'NCU High Gain LoRa Antenna', 'Accessory'),
  product(3, 'TCU-002-SAT', 'AC Powered tracker', 'TCU'),
  product(4, 'cab-fly-001', 'USB-C to USB-C cable', 'Accessory'),
];

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => PRODUCTS, text: async () => JSON.stringify(PRODUCTS), headers: new Headers({ 'content-type': 'application/json' }) }) as unknown as Response));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const models = () => [...host.querySelectorAll('tbody tr td:first-child')].map((td) => td.textContent);
const search = async (value: string) => {
  const input = host.querySelector('input[aria-label="Search products"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('ProductionCostsView', () => {
  it('lists products ascending by model number, numbers in order', async () => {
    await act(async () => { root.render(<ProductionCostsView triggerToast={() => {}} />); });
    await settle();
    expect(models()).toEqual(['ANT-LORA-NCU', 'cab-fly-001', 'TCU-002-SAT', 'TCU-010-SAT']);
  });

  it('searches model numbers and descriptions', async () => {
    await act(async () => { root.render(<ProductionCostsView triggerToast={() => {}} />); });
    await settle();
    await search('tracker');
    expect(models()).toEqual(['TCU-002-SAT', 'TCU-010-SAT']);
    expect(host.textContent).toContain('2 of 4');
    await search('cab-fly');
    expect(models()).toEqual(['cab-fly-001']);
    await search('nothing like this');
    expect(host.textContent).toContain('No products match the search.');
  });
});
