import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InventoryView } from './InventoryView';

// The Items & Inventory price filter, on top of the list App has filtered.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const item = (partNumber: string, price: number) =>
  ({ partNumber, name: `${partNumber} name`, description: '', manufacturer: '', stockLevel: 25, price, category: 'X', status: 'ACTIVE' }) as any;
const ITEMS = [item('CAP-009', 0.02), item('CHP-002', 3.2), item('ANT-001', 12), item('ENC-004', 45)];

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const noop = () => {};
const render = async (usdToZar?: number) => {
  await act(async () => {
    root.render(<InventoryView usdToZar={usdToZar} items={ITEMS} filteredItems={ITEMS} searchQuery="" setSearchQuery={noop} selectedItemType="ALL" setSelectedItemType={noop}
      selectedStatus="ALL" setSelectedStatus={noop} selectedStockStatus="ALL" setSelectedStockStatus={noop} selectedPackaging="ALL" setSelectedPackaging={noop}
      availablePackagingModes={[]} availablePrefixes={[]} sortBy="name" setSortBy={noop} handleResetFilters={noop} setShowImportModal={noop}
      setShowAddModal={noop} setSelectedDetailPartNumber={noop} />);
  });
};
const shown = () => ITEMS.map((i) => i.partNumber).filter((pn) => host.textContent?.includes(pn));
const yieldText = () => host.textContent?.match(/Yield: (\d+) \/ (\d+)/)?.slice(1);
const type = async (label: string, value: string) => {
  const input = host.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('Items & Inventory price filter', () => {
  it('keeps the items in the price range, in dollars or rand, and can be cleared', async () => {
    await render();
    expect(shown()).toEqual(['CAP-009', 'CHP-002', 'ANT-001', 'ENC-004']);

    await type('Minimum price', '1');
    await type('Maximum price', '20');
    expect(shown()).toEqual(['CHP-002', 'ANT-001']);
    expect(yieldText()).toEqual(['2', '4']);

    const currency = host.querySelector('select[aria-label="Price currency"]') as HTMLSelectElement;
    await act(async () => { currency.value = 'ZAR'; currency.dispatchEvent(new Event('change', { bubbles: true })); });
    // R1 – R20: only the $0.02 capacitor (R0.37) is under R1; $3.20 is R59.20.
    expect(shown()).toEqual([]);
    await type('Maximum price', '');
    expect(shown()).toEqual(['CHP-002', 'ANT-001', 'ENC-004']);

    await act(async () => { (host.querySelector('button[aria-label="Clear price filter"]') as HTMLButtonElement).click(); });
    expect(shown()).toEqual(['CAP-009', 'CHP-002', 'ANT-001', 'ENC-004']);
    expect((host.querySelector('select[aria-label="Price currency"]') as HTMLSelectElement).value).toBe('ZAR');
  });
});

describe('rand prices', () => {
  it('use the daily rate when the app has it, and say which rate', async () => {
    await render(20);
    expect(host.textContent).toContain('R240.00'); // ANT-001: $12 at 20
    expect(host.querySelector('[title^="Rand at 20.00 ZAR/USD (the daily rate)"]')).not.toBeNull();
    await type('Minimum price', '');
    const currency = host.querySelector('select[aria-label="Price currency"]') as HTMLSelectElement;
    await act(async () => { currency.value = 'ZAR'; currency.dispatchEvent(new Event('change', { bubbles: true })); });
    await type('Minimum price', '240');
    expect(shown()).toEqual(['ANT-001', 'ENC-004']);
  });

  it('fall back to a fixed rate, saying so, before the daily rate loads', async () => {
    await render();
    expect(host.querySelector('[title*="fallback"]')).not.toBeNull();
  });
});
