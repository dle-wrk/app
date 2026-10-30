import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SupplierBOMGeneratorView } from './views/SupplierBOMGeneratorView';
import { toRsCsv, rsSearchUrl } from '../lib/supplierBom';
import { isRsStockNumber, rsNumberIn, classifyPartNumberBySupplier } from '../lib/partNumbers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('./RestockOrderFiles', () => ({ default: () => null }));

describe('RS Components numbers and files', () => {
  it('knows an RS stock number, in any slot, and never calls it Mouser', () => {
    expect(isRsStockNumber(' 534-2993 ')).toBe(true);
    expect(isRsStockNumber('652-SRR1210-100M')).toBe(false);
    expect(isRsStockNumber('5342993')).toBe(false);
    expect(rsNumberIn(['652-SRR1210-100M', '', 'C12345', '534-2993'])).toBe('534-2993');
    expect(rsNumberIn(undefined)).toBe('');
    expect(classifyPartNumberBySupplier('534-2993')).toBeNull();
  });

  it('writes RS Stock No., Quantity, Description, Stock code', () => {
    expect(toRsCsv([{ supplierPn: '534-2993', qty: 20, description: '10µH "shielded"', footprint: '', stockCodes: ['IND-004'] }]))
      .toBe('RS Stock No.,Quantity,Description,Stock code\n534-2993,20,"10uH \'shielded\'","IND-004"\n');
  });

  it('searches RS South Africa', () => {
    expect(rsSearchUrl(' SRR1210-100M ')).toBe('https://za.rs-online.com/web/c/?searchTerm=SRR1210-100M');
    expect(rsSearchUrl('10uF 0805')).toBe('https://za.rs-online.com/web/c/?searchTerm=10uF%200805');
  });
});

let host: HTMLDivElement; let root: Root; let calls: Array<{ method: string; url: string; body: any }>;
beforeEach(() => {
  calls = [];
  localStorage.setItem('currentUser', JSON.stringify({ role: 'admin' }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
    const ok = (b: any) => ({ ok: true, json: async () => b }) as any;
    if (url === '/api/supplier-bom/lookup') return ok([
      { part: 'IND-004', found: true, name: '10UH', description: 'Inductor 10uH', footprint: '1210', mpn: 'SRR1210-100M', supplierPns: { LCSC: '', DigiKey: '', Mouser: '652-SRR1210-100M', RS: '' } },
      { part: 'RES-020', found: true, name: '10K', description: 'Resistor 10k', footprint: '0603', mpn: '', supplierPns: { LCSC: 'C25804', DigiKey: '', Mouser: '', RS: '123-4567' } },
    ]);
    if (url === '/api/inventory/IND-004/rs-number') return ok({ serialNumber: 'IND-004', rsNumber: '534-2993', slot: 4 });
    return ok({});
  }));
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;

describe('Supplier BOM Generator: RS', () => {
  it('shows RS numbers, finds the missing ones on RS, saves one, and exports the RS file', async () => {
    const toast = vi.fn();
    await act(async () => { root.render(<SupplierBOMGeneratorView triggerToast={toast} />); });
    const file = new File(['Part,Qty\nIND-004,2\nRES-020,4\n'], 'board.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: async () => 'Part,Qty\nIND-004,2\nRES-020,4\n' });
    const input = host.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [file] });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { button('RS').click(); });

    expect(host.querySelector('[data-testid="rs-help"]')).not.toBeNull();
    expect((host.querySelector('a[aria-label="Open 123-4567 on RS"]') as HTMLAnchorElement).href).toBe('https://za.rs-online.com/web/c/?searchTerm=123-4567');
    expect((host.querySelector('a[aria-label="Find IND-004 on RS"]') as HTMLAnchorElement).href).toBe('https://za.rs-online.com/web/c/?searchTerm=SRR1210-100M');

    const box = host.querySelector('input[aria-label="RS stock number for IND-004"]') as HTMLInputElement;
    act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(box, '534-2993'); box.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { button('Save').click(); });
    expect(calls.find((c) => c.method === 'PUT')).toEqual({ method: 'PUT', url: '/api/inventory/IND-004/rs-number', body: { rsNumber: '534-2993' } });
    expect(host.querySelector('a[aria-label="Open 534-2993 on RS"]')).not.toBeNull();

    // The download: capture the file the page hands the browser.
    let blob: Blob | null = null; let name = '';
    (URL as any).createObjectURL = (b: Blob) => { blob = b; return 'blob:rs'; };
    (URL as any).revokeObjectURL = () => {};
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { name = this.download; });
    await act(async () => { button('Export RS CSV').click(); });
    expect(click).toHaveBeenCalled();
    expect(name).toBe('rs_bom.csv');
    const text = await blob!.text();
    expect(text).toContain('534-2993,2,"Inductor 10uH","IND-004"');
    expect(text).toContain('123-4567,4,"Resistor 10k","RES-020"');
    expect(toast).toHaveBeenLastCalledWith(expect.stringMatching(/^RS BOM exported/));
  });
});
