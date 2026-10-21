import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BOMManager from './BOMManager';
import { setConfirmHandler } from '../lib/confirmDialog';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// TCU06: 18 x RES-033 per board; at 1000 boards that's 18 000 against 4 752 on the reel.
const item = (partNumber: string, stockLevel: number) => ({ partNumber, name: '10k', description: '10k 0603', value: '10k', footprint: '0603', stockLevel, price: 0, category: 'Resistors', status: 'ACTIVE' } as any);
const items = [item('RES-033', 4752), item('RES-041', 20000)];
const bomItems = [{ id: 'b1', projectId: 1, stockCode: 'RES-033', comment: '', description: '10k', designator: 'R1', footprint: '0603', libref: '', quantity: 18 }] as any;

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ url: string; body: any }>;
beforeEach(() => {
  calls = [];
  localStorage.setItem('currentUser', JSON.stringify({ role: 'admin' }));
  setConfirmHandler(async () => true);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    const ok = (data: unknown) => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => data, text: async () => JSON.stringify(data) });
    if (url === '/api/kits/match/batch') return ok({ 'RES-033': [
      { serialNumber: 'RES-033', name: '10k', description: '', footprint: '0603', stock: 4752, status: 'ACTIVE', matchTier: 1, matchNote: '' },
      { serialNumber: 'RES-041', name: '10k', description: '', footprint: '0603', stock: 20000, status: 'ACTIVE', matchTier: 2, matchNote: '' },
    ] });
    if (url === '/api/kit-booking/execute') return ok({ ok: true });
    if (url === '/api/items') return ok([]);
    if (url === '/api/transactions') return ok([]);
    return ok([]);
  }));
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); setConfirmHandler(null); localStorage.removeItem('currentUser'); });
const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const button = (re: RegExp) => [...host.querySelectorAll('button')].find((b) => re.test(b.textContent ?? '')) as HTMLButtonElement;

describe('Bill of Materials allocations', () => {
  it('auto-allocates a line across reels by tier for the PCB quantity, and books out those picks', async () => {
    const toast = vi.fn();
    await act(async () => { root.render(<BOMManager items={items} setItems={() => {}} transactions={[]} setTransactions={() => {}} projects={[{ id: 1, projectName: 'TCU06 PCB' } as any]} bomItems={bomItems} triggerToast={toast} />); });
    await act(async () => { button(/^\s*1000\s*$/).click(); });
    await settle();
    expect(host.textContent).toContain('SHORTAGE: -13248');

    await act(async () => { button(/Auto-allocate/i).click(); });
    await settle();
    expect(toast).toHaveBeenLastCalledWith('1 line filled for 1000 PCBs', 'SUCCESS');
    expect(host.textContent).toContain('RES-033 ×4');
    expect(host.textContent).toContain('RES-041 ×13');
    expect(host.textContent).toContain('from 2 reels');
    expect(host.textContent).not.toContain('SHORTAGE');

    await act(async () => { button(/Book out entire BOM/i).click(); });
    await settle();
    const confirm = [...host.querySelectorAll('button')].filter((b) => /book out|confirm/i.test(b.textContent ?? '')).at(-1)!;
    await act(async () => { confirm.click(); });
    await settle();
    const exec = calls.find((c) => c.url === '/api/kit-booking/execute');
    expect(exec?.body).toEqual({ projectId: 1, buildQty: 1000, allocations: { 'RES-033': [{ allocatedCode: 'RES-033', qty: 4752 }, { allocatedCode: 'RES-041', qty: 13248 }] }, dnf: [] });
  });
});
