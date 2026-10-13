import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RestockOrderFiles from './RestockOrderFiles';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let blobText = '';
let savedName = '';
beforeEach(() => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  (URL as any).createObjectURL = vi.fn((b: Blob) => { b.text().then((t) => { blobText = t; }); return 'blob:x'; });
  (URL as any).revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { savedName = this.download; });
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

describe('restock order files', () => {
  it('turns the reorder recommendations into a file per supplier', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ orderLines: [
      { stockCode: 'CAP-001', description: '100nF', footprint: '0603', supPns: ['187-CL10B104', 'N/A', 'C1591', 'N/A', 'N/A'], qty: 400, urgency: 'CRITICAL' },
      { stockCode: 'RES-001', description: '10k', footprint: '0603', supPns: ['N/A', 'N/A', 'C25804', 'N/A', 'N/A'], qty: 250, urgency: 'MEDIUM' },
    ] }) })));
    await act(async () => { root.render(<RestockOrderFiles onShowNotification={() => {}} />); });
    await settle();
    expect(host.textContent).toContain('2 items need reordering (1 urgent)');
    expect(host.querySelector('[aria-label="Quantities"]')).toBeNull(); // no shortages/build choice here
    await act(async () => { (host.querySelector('[aria-label="Download LCSC order file"]') as HTMLButtonElement).click(); });
    await settle();
    expect(savedName).toMatch(/^restock_lcsc_\d{4}-\d{2}-\d{2}\.csv$/);
    expect(blobText).toBe('Comment,Designator,Footprint,LCSC Part #,Quantity\n"100nF","","0603","C1591",400\n"10k","","0603","C25804",250\n');
  });

  it('says so when nothing needs reordering, or when it can not be worked out', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ orderLines: [] }) })));
    await act(async () => { root.render(<RestockOrderFiles onShowNotification={() => {}} />); });
    await settle();
    expect(host.textContent).toContain('Nothing needs reordering.');
  });
});
