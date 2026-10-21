import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import KitBookingView from './KitBookingView';
import { fillByTier } from '../../lib/kitTierFill';
import { setConfirmHandler } from '../../lib/confirmDialog';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('fillByTier', () => {
  const list = [
    { serialNumber: 'CAP-009', stock: 300, matchTier: 2 },
    { serialNumber: 'CAP-001', stock: 400, matchTier: 1 },
    { serialNumber: 'CAP-050', stock: 9999, matchTier: 3 }, // footprint swap: never auto-picked
  ];
  it('takes T1 first, then T2, after other kits\' reservations; never T3/T4', () => {
    expect(fillByTier(list, 500, { 'CAP-001': 100 })).toEqual({ picks: [{ allocatedCode: 'CAP-001', qty: 300 }, { allocatedCode: 'CAP-009', qty: 200 }], remaining: 0 });
    expect(fillByTier(list, 1000, {})).toEqual({ picks: [{ allocatedCode: 'CAP-001', qty: 400 }, { allocatedCode: 'CAP-009', qty: 300 }], remaining: 300 });
    expect(fillByTier(list, 50, {})).toEqual({ picks: [{ allocatedCode: 'CAP-001', qty: 50 }], remaining: 0 });
  });
});

// Kit Booking with a one-line BOM: 2 per board of CAP-001 (T1, 400 free) or CAP-009 (T2, 300 free).
let host: HTMLDivElement;
let root: Root;
let toast: ReturnType<typeof vi.fn>;
beforeEach(() => {
  toast = vi.fn();
  localStorage.setItem('currentUser', JSON.stringify({ role: 'admin' }));
  setConfirmHandler(async () => true);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const ok = (data: unknown) => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => data, text: async () => JSON.stringify(data) });
    if (url === '/api/kit-booking/validate') {
      return ok([{ component_id: 'CAP-001', resolved_part_number: 'CAP-001', qty_required: 2 * body.buildQty, stock_on_hand: 400, reserved_qty: 0, status: 'OK', description: '100nF', footprint: '0603' }]);
    }
    if (url === '/api/kits/match/batch') return ok({ 'CAP-001': [{ serialNumber: 'CAP-001', name: '100nF', description: '', footprint: '0603', stock: 400, status: 'ACTIVE', matchTier: 1, matchNote: '' }, { serialNumber: 'CAP-009', name: '100nF', description: '', footprint: '0603', stock: 300, status: 'ACTIVE', matchTier: 2, matchNote: '' }] });
    return ok([]);
  }));
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); setConfirmHandler(null); localStorage.removeItem('currentUser'); });
const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const button = (re: RegExp) => [...host.querySelectorAll('button')].find((b) => re.test(b.textContent ?? '')) as HTMLButtonElement;

describe('Auto-allocate', () => {
  it('fills by tier for the build quantity chosen, and refills when it changes', async () => {
    await act(async () => { root.render(<KitBookingView projects={[{ id: 1, projectName: 'TCU06 PCB' } as any]} triggerToast={toast} currentUser={{ role: 'admin' }} />); });
    await settle();
    await act(async () => { button(/^\s*50\s*$/).click(); });
    await settle();
    await act(async () => { button(/Auto-allocate/i).click(); });
    await settle();
    expect(toast).toHaveBeenLastCalledWith('1 line filled for 50 units', 'SUCCESS');

    // 1000 boards need 2000: CAP-001's 400 then CAP-009's 300, still short.
    await act(async () => { button(/^\s*1000\s*$/).click(); });
    await settle();
    await act(async () => { button(/Auto-allocate/i).click(); });
    await settle();
    expect(toast).toHaveBeenLastCalledWith('1 line filled for 1000 units · 1 still short after fill', 'INFO');
    expect(host.textContent).toContain('700/2000');
  });
});
