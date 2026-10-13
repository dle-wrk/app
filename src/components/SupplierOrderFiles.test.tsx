import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SupplierOrderFiles from './SupplierOrderFiles';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let saved: Array<{ name: string; text: string }>;
beforeEach(() => {
  saved = [];
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  (URL as any).createObjectURL = vi.fn((b: Blob) => { (globalThis as any).__lastBlob = b; return 'blob:x'; });
  (URL as any).revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    saved.push({ name: this.download, text: '' });
  });
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

const lines = [
  { stockCode: 'CAP-001', description: '100nF', footprint: '0603', supPns: ['187-CL10B104', '1276-1000-1-ND', 'C1591'], required: 100, shortage: 40 },
  { stockCode: 'CHP-027', description: 'USB hub', footprint: 'QFN-36', supPns: ['N/A', 'N/A', 'C626667'], required: 2, shortage: 0 },
  { stockCode: 'MEC-001', description: 'Bracket', footprint: '', supPns: ['N/A', 'N/A', 'N/A'], required: 2, shortage: 2 },
];

describe('order files on the project BOM', () => {
  it('counts lines per supplier for the shortages or the whole build, and downloads a file per supplier', async () => {
    const toast = vi.fn();
    await act(async () => { root.render(<SupplierOrderFiles lines={lines} projectName="TCU06 Rev B" pcbQty={50} onShowNotification={toast} />); });
    const text = () => host.textContent ?? '';
    expect(text()).toContain('1 lines · 1 not listed'); // shortages: CAP-001 at Mouser; MEC-001 nowhere
    expect(text()).toContain('1 line has no Mouser, DigiKey or LCSC number');

    await act(async () => { (host.querySelector('[aria-label="Download LCSC order file"]') as HTMLButtonElement).click(); });
    expect(saved.map((f) => f.name)).toEqual(['TCU06_Rev_B_lcsc_shortages_50pcs.csv']);
    const blob: Blob = (globalThis as any).__lastBlob;
    expect(await blob.text()).toBe('Comment,Designator,Footprint,LCSC Part #,Quantity\n"100nF","","0603","C1591",40\n');

    const build = [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Whole build'))!;
    await act(async () => { build.click(); });
    expect(text()).toContain('2 lines · 1 not listed'); // LCSC now has CHP-027 too
  });

  it('says so when nothing is short', async () => {
    await act(async () => { root.render(<SupplierOrderFiles lines={[{ ...lines[0], shortage: 0 }]} projectName="X" pcbQty={5} onShowNotification={() => {}} />); });
    expect(host.textContent).toContain('Nothing is short for 5 pcs');
  });

  it('compares prices and splits the order so each line goes to its cheapest supplier; a price can be clicked instead', async () => {
    localStorage.setItem('currentUser', JSON.stringify({ role: 'admin' }));
    const priced = (supplierPn: string, totalZar: number, extra = {}) => ({ supplierPn, orderQty: 40, unit: totalZar / 40, currency: 'ZAR', unitZar: totalZar / 40, totalZar, stock: 1000, enoughStock: true, note: null, ...extra });
    const posted: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') { posted.push(JSON.parse(String(init.body))); return { ok: true, json: async () => ({ id: 'q1' }) }; }
      return { ok: true, json: async () => ({ finished: true, done: 3, total: 3, lines: [
        { stockCode: 'CAP-001', qty: 40, best: 'lcsc', quotes: { mouser: priced('187-CL10B104', 30), digikey: priced('1276-1000-1-ND', 25), lcsc: priced('C1591', 13.19) } },
        { stockCode: 'MEC-001', qty: 2, best: null, quotes: {} },
      ] }) };
    }));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await act(async () => { root.render(<SupplierOrderFiles lines={lines} projectName="TCU06" pcbQty={50} onShowNotification={() => {}} />); });
      const compare = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Compare prices'))!;
      await act(async () => { compare.click(); });
      expect(posted[0].lines.map((l: any) => [l.stockCode, l.qty])).toEqual([['CAP-001', 40]]); // MEC-001 has no supplier number
      await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
      const summary = host.querySelector('[data-testid="price-summary"]')!;
      expect(summary.textContent).toContain('Cheapest per line: R13.19');
      expect(summary.textContent).toContain('R16.81 less than the dearest quote on each line');

      await act(async () => { (host.querySelector('[aria-label="Download LCSC order file"]') as HTMLButtonElement).click(); });
      expect(saved.at(-1)!.name).toBe('TCU06_lcsc_cheapest_shortages_50pcs.csv');
      expect((host.querySelector('[aria-label="Download Mouser order file"]') as HTMLButtonElement).disabled).toBe(true); // nothing cheapest there

      await act(async () => { (host.querySelector('[aria-label="Buy CAP-001 at DigiKey"]') as HTMLButtonElement).click(); });
      expect(summary.textContent).toContain('Your choice: R25.00');
      expect((host.querySelector('[aria-label="Download LCSC order file"]') as HTMLButtonElement).disabled).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      localStorage.removeItem('currentUser');
    }
  });
});
