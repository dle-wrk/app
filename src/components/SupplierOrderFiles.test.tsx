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
});
