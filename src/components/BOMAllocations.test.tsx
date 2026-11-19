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
// A BOM pick as the server returns it (src/lib/bomPicks.ts): RES-033 four reels' worth, RES-041 the rest.
const pickLine = (id: number, code: string, need: number, picked: number, reel = false) => ({
  id, bomCode: 'RES-033', code, need, picked, state: picked >= need ? 'done' : picked > 0 ? 'part' : 'todo', itemsForBomLine: 2, reel,
  item: { name: '10k' }, places: [], scans: picked ? [{ id: id * 10, locationCode: code, lot: null, qty: picked, wholeReel: reel, by: 'Sam' }] : [],
});
let pickResponse: any;
let openPicks: any[];
beforeEach(() => {
  calls = [];
  openPicks = [];
  pickResponse = { id: 7, projectId: 1, projectName: 'TCU06 PCB', buildQty: 1000, status: 'OPEN', createdBy: 'Dylan', picker: 'Sam', pickerSeenAt: new Date().toISOString(),
    lines: [pickLine(1, 'RES-033', 4752, 4752, true), pickLine(2, 'RES-041', 13248, 20000, true)], done: 2, total: 2, complete: true };
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
    if (String(url).startsWith('/api/bom-picks?')) return ok({ items: openPicks });
    if (url === '/api/bom-picks' || url === '/api/bom-picks/7') return ok(pickResponse);
    if (url === '/api/bom-picks/7/book-out') return ok({ result: { units: 24752, items: [{ code: 'RES-033', qty: 4752 }, { code: 'RES-041', qty: 20000 }] }, pick: { ...pickResponse, status: 'BOOKED' } });
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
  it('auto-allocates a line across reels by tier, sends those picks to the scanner, and books out what was scanned after the final check', async () => {
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

    // Book Out Entire BOM starts a pick for the phone: nothing is booked out yet.
    await act(async () => { button(/Book out entire BOM/i).click(); });
    await settle();
    expect(calls.find((c) => c.url === '/api/bom-picks')?.body).toEqual({ projectId: 1, buildQty: 1000, lines: [{ bomCode: 'RES-033', need: 18000, picks: [{ code: 'RES-033', qty: 4752 }, { code: 'RES-041', qty: 13248 }] }] });
    expect(calls.some((c) => c.url === '/api/kit-booking/execute')).toBe(false);
    const panel = host.querySelector('[role="dialog"]')!;
    expect(panel.textContent).toContain('SCAN BOM ITEMS');
    expect(panel.textContent).toContain('Sam is scanning');
    expect([...host.querySelectorAll('[data-testid="bom-pick-lines"] li')].map((li) => li.getAttribute('data-state'))).toEqual(['done', 'done']);

    // Every line scanned: the final check shows what was scanned, whole reels included, then books it out.
    await act(async () => { button(/^\s*Final check\s*$/).click(); });
    expect(host.querySelector('[data-testid="bom-final-check"]')?.textContent).toContain('20,000'.replace(',', '\u00a0'));
    expect(host.textContent).toContain('RES-041 +6');
    await act(async () => { button(/Approve & book out/).click(); });
    await settle();
    expect(calls.some((c) => c.url === '/api/bom-picks/7/book-out')).toBe(true);
    expect(toast).toHaveBeenLastCalledWith(expect.stringContaining('as scanned'));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it('picks up an open pick: a scanned line is green and its allocation can no longer be changed', async () => {
    openPicks = [{ id: 7 }];
    pickResponse = { ...pickResponse, lines: [pickLine(1, 'RES-033', 18000, 18000)], done: 1, total: 1 };
    pickResponse.lines[0].itemsForBomLine = 1;
    await act(async () => { root.render(<BOMManager items={items} setItems={() => {}} transactions={[]} setTransactions={() => {}} projects={[{ id: 1, projectName: 'TCU06 PCB' } as any]} bomItems={bomItems} triggerToast={() => {}} />); });
    await settle();
    const row = host.querySelector('tbody tr')!;
    expect(row.getAttribute('data-scan-state')).toBe('done');
    expect(row.textContent).toContain('SCANNED');
    expect(host.querySelector('[aria-label="Allocate reels for RES-033"]')).toBeNull();
    expect(host.querySelector('[data-testid="bom-pick-status"]')?.textContent).toContain('1 of 1 items picked');
    expect(button(/Final check & book out/)).toBeTruthy();
  });

  it('shows a part the BOM lists twice as one line, with its quantities added', async () => {
    const dup = [
      { id: 'a', projectId: 1, stockCode: 'CAP-024', comment: '', description: '100nF', designator: 'C47, C43, C44, C49, C50', footprint: '1206', libref: '', quantity: 5 },
      { id: 'b', projectId: 1, stockCode: 'CAP-024', comment: '', description: '100nF', designator: 'C14, C15, C16', footprint: '1206', libref: '', quantity: 11 },
    ] as any;
    await act(async () => { root.render(<BOMManager items={[item('CAP-024', 1800)]} setItems={() => {}} transactions={[]} setTransactions={() => {}} projects={[{ id: 1, projectName: 'TCU06 PCB' } as any]} bomItems={dup} triggerToast={() => {}} />); });
    await act(async () => { button(/^\s*1000\s*$/).click(); });
    await settle();
    expect(host.querySelectorAll('tbody tr').length).toBe(1);
    expect(host.textContent).toContain('Merged from 2 BOM rows');
    expect(host.textContent).toContain('SHORTAGE: -14200'); // 16 000 needed, 1 800 in stock
  });
});