import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ItemDetailModal from './ItemDetailModal';
import { classifyPartNumberBySupplier, rightSlotFor } from '../lib/partNumbers';

// Supplier part-number slots: 1 Mouser, 2 DigiKey, 3 LCSC, 4-5 other.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('supplier part-number rules', () => {
  it('tell whose number it looks like', () => {
    expect(['C365814', '5440-FM31X104K251EEGTR-ND', '581-08051C104KAT2A', 'GRM188R71H104KA93D', ''].map(classifyPartNumberBySupplier))
      .toEqual(['lcsc', 'digikey', 'mouser', null, null]);
  });

  it('say which slot a number belongs in when it is in another', () => {
    expect(rightSlotFor('5440-FM31X104K251EEGTR-ND', 0)).toBe(1);
    expect(rightSlotFor('C365814', 1)).toBe(2);
    expect(rightSlotFor('C365814', 2)).toBeNull();
    expect(rightSlotFor('C365814', 3)).toBe(2);
    expect(rightSlotFor('GRM188R71H104KA93D', 0)).toBeNull();
  });
});

describe('the item form', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => { localStorage.setItem('currentUser', JSON.stringify({ role: 'engineer' })); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it('labels each slot with its supplier and moves a number to the right one', async () => {
    const onSave = vi.fn();
    const item = {
      partNumber: 'CAP-009', name: '100nF', description: '', manufacturer: 'X', supplier: 'N/A', stockLevel: 1, price: 0, category: 'Capacitors', status: 'ACTIVE',
      supPns: ['5440-FM31X104K251EEGTR-ND', 'C365814', '', '', ''],
    } as any;
    await act(async () => { root.render(<ItemDetailModal item={item} onClose={() => {}} onSave={onSave} />); });
    await act(async () => { (document.getElementById('btn-edit-item') as HTMLButtonElement).click(); });

    const input = (n: number) => host.querySelector(`input[name="supPns_${n}"]`) as HTMLInputElement;
    expect(input(0).getAttribute('aria-label')).toBe('Supplier part number 1 (Mouser)');
    expect(input(1).getAttribute('aria-label')).toBe('Supplier part number 2 (DigiKey)');
    expect(input(2).getAttribute('aria-label')).toBe('Supplier part number 3 (LCSC)');
    expect(input(3).getAttribute('aria-label')).toBe('Supplier part number 4 (Other)');
    expect(host.textContent).toContain('Looks like a DigiKey number.');

    const move = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement;
    await act(async () => { move('Move to 2. DigiKey').click(); });
    // Swapped: the DigiKey number in slot 2, and the LCSC code now in slot 1.
    expect([input(0).value, input(1).value]).toEqual(['C365814', '5440-FM31X104K251EEGTR-ND']);
    await act(async () => { move('Move to 3. LCSC').click(); });
    expect([input(0).value, input(1).value, input(2).value]).toEqual(['', '5440-FM31X104K251EEGTR-ND', 'C365814']);
    expect(host.textContent).not.toContain('Looks like');

    await act(async () => { (document.getElementById('item-detail-form') as HTMLFormElement).requestSubmit(); });
    expect(onSave.mock.calls[0][0].supPns).toEqual(['', '5440-FM31X104K251EEGTR-ND', 'C365814', '', '']);
  });
});

describe('item details by role', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); localStorage.clear(); });
  const item = { partNumber: 'CAP-009', name: '100nF', description: '', manufacturer: 'X', supplier: 'N/A', stockLevel: 1, price: 0, category: 'Capacitors', status: 'ACTIVE' } as any;
  it.each([['viewer', false, false], ['engineer', true, false], ['manager', true, true]])('%s: edit %s, delete %s', async (role, edit, del) => {
    localStorage.setItem('currentUser', JSON.stringify({ role }));
    await act(async () => { root.render(<ItemDetailModal item={item} onClose={() => {}} onSave={() => {}} />); });
    expect(!!document.getElementById('btn-edit-item')).toBe(edit);
    expect(!!document.getElementById('btn-delete-item')).toBe(del);
  });
});
