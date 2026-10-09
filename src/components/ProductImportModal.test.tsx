import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductImportModal } from './ProductImportModal';

// The Production Costs import dialog against a stubbed API.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const CSV = 'Model #,Description,Selling price,Margin %\r\nTCU-001-SAT,,"R 9 100,00",40%\r\nDON-004-SATD,New dongle,900,\r\n';
const PLAN = {
  added: 1, updated: 1, unchanged: 0,
  changes: [
    { line: 2, modelNumber: 'TCU-001-SAT', kind: 'changed', id: 1, set: { sellingPrice: 9100 }, before: { sellingPrice: 8827.89 } },
    { line: 3, modelNumber: 'DON-004-SATD', kind: 'new', id: null, set: { description: 'New dongle', sellingPrice: 900 }, before: {} },
  ],
};

let calls: Array<{ url: string; body: any }>;
let reply: { status: number; body: unknown } | null;
const imported = vi.fn();
const toast = vi.fn();
let host: HTMLDivElement;
let root: Root;
const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

beforeEach(() => {
  calls = []; reply = null; imported.mockClear(); toast.mockClear();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(input), body });
    const r = reply ?? { status: 200, body: { ...PLAN, applied: !!body.apply } };
    return { ok: r.status < 400, status: r.status, json: async () => r.body } as unknown as Response;
  }));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const render = async () => {
  await act(async () => { root.render(<ProductImportModal onClose={() => {}} onImported={imported} onExport={() => {}} triggerToast={toast} />); });
};
const choose = async (name: string, content: string) => {
  const input = host.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [new File([content], name, { type: 'text/csv' })], configurable: true });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  await settle();
};
const importButton = () => [...host.querySelectorAll('button')].find((b) => /^Import/.test(b.textContent?.trim() ?? '')) as HTMLButtonElement;

describe('ProductImportModal', () => {
  it('reads the file, previews what changes, and imports it', async () => {
    await render();
    expect(importButton().disabled).toBe(true);
    await choose('prices.csv', CSV);
    expect(calls[0]).toEqual({ url: '/api/production-products/import', body: { apply: false, rows: [
      { line: 2, modelNumber: 'TCU-001-SAT', sellingPrice: 9100 },
      { line: 3, modelNumber: 'DON-004-SATD', description: 'New dongle', sellingPrice: 900 },
    ] } });
    expect(host.querySelector('[data-testid="import-summary"]')!.textContent).toContain('1 new');
    expect(host.textContent).toContain('Columns not imported: Margin %.');
    expect(host.querySelector('[data-testid="import-row-TCU-001-SAT"]')!.textContent).toMatch(/Selling price: R8.827\.89 → R9.100\.00/);
    expect(importButton().textContent).toBe('Import 2 products');

    await act(async () => { importButton().click(); });
    await settle();
    expect(calls[1].body.apply).toBe(true);
    expect(imported).toHaveBeenCalledWith('Imported prices.csv: 1 added, 1 updated, 0 unchanged.');
  });

  it("explains a file it can't read", async () => {
    await render();
    await choose('list.csv', 'Name,Price\r\nx,1\r\n');
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('list.csv can\'t be imported: it has no model number column (a header such as "Model #" or "Model number").');
    expect(calls).toEqual([]);
  });

  it("says when the server refuses, and changes nothing", async () => {
    await render();
    await choose('prices.csv', CSV);
    reply = { status: 403, body: { error: 'Only admins, managers and engineers can change inventory, prices and part numbers.' } };
    await act(async () => { importButton().click(); });
    await settle();
    expect(toast).toHaveBeenCalledWith('The import failed, nothing was changed: Only admins, managers and engineers can change inventory, prices and part numbers.', 'ERROR');
    expect(imported).not.toHaveBeenCalled();
  });
});
