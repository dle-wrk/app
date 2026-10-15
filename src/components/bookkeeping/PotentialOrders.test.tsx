import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PotentialOrdersTab } from './PotentialOrdersTab';
import { MoveToPotential } from './MoveToPotential';
import { ClientHistory } from './ClientHistory';
import { FollowUpsCard } from '../views/FollowUpsCard';
import { pipelineTotals, sortHistory } from '../../lib/potentialOrders';
import { permissionForWrite } from '../../lib/writeAccess';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ url: string; method: string; body: any }>;
let responses: Record<string, unknown>;
beforeEach(() => {
  calls = [];
  responses = {};
  localStorage.setItem('currentUser', JSON.stringify({ role: 'admin' }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method || 'GET';
    calls.push({ url: String(url), method, body: init?.body ? JSON.parse(String(init.body)) : null });
    const data = responses[`${method} ${url}`] ?? responses[`${method} ${String(url).split('?')[0]}`] ?? {};
    return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => data, text: async () => JSON.stringify(data) };
  }));
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); localStorage.removeItem('currentUser'); });

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const button = (text: string | RegExp) => [...host.querySelectorAll('button')].find((b) => (typeof text === 'string' ? b.textContent?.trim() === text : text.test(b.textContent ?? ''))) as HTMLButtonElement;
const setValue = (el: HTMLInputElement | HTMLSelectElement, v: string) => {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
};
const byLabel = (l: string) => host.querySelector(`[aria-label="${l}"]`) as HTMLInputElement;

describe('totals and history order', () => {
  it('adds up open potential orders, weighted by likelihood', () => {
    expect(pipelineTotals([
      { status: 'OPEN', total: 1000, likelihoodPct: 90, expectedDate: '2026-10-01' },
      { status: 'OPEN', total: 2000, likelihoodPct: null, expectedDate: '2026-12-01' },
      { status: 'WON', total: 5000, likelihoodPct: 75, expectedDate: null },
    ], '2026-10-15')).toEqual({ count: 2, total: 3000, weighted: 1900, decisionDue: 1 });
  });

  it('lists history newest first, notes before documents on the same moment', () => {
    const e = (at: string, eventId: number | null) => ({ at, eventId } as any);
    expect(sortHistory([e('2026-10-01', null), e('2026-10-15', null), e('2026-10-15', 4)]).map((x) => [x.at, x.eventId])).toEqual([['2026-10-15', 4], ['2026-10-15', null], ['2026-10-01', null]]);
  });

  it('only admins and managers can change them (bookkeeping rule)', () => {
    expect(permissionForWrite('POST', '/api/potential-orders/from-invoice/7')).toBe('orders.update');
    expect(permissionForWrite('POST', '/api/clients/3/events')).toBe('orders.update');
    expect(permissionForWrite('PUT', '/api/client-events/9')).toBe('orders.update');
  });
});

describe('Move to Potential Order', () => {
  it('says what happens to the books, and moves it with the details given', async () => {
    responses['POST /api/potential-orders/from-invoice/7'] = { number: 'POT-2026-0001' };
    const onMoved = vi.fn();
    await act(async () => { root.render(<MoveToPotential source="invoice" id={7} number="INV-2026-0005" status="OVERDUE" onMoved={onMoved} onError={() => {}} />); });
    await act(async () => { button(/Move to Potential Order/).click(); });
    expect(host.textContent).toContain('INV-2026-0005 is taken out of the books: its journal entry (the amount owed, revenue and VAT) is reversed');
    await act(async () => { setValue(byLabel('Expected decision date'), '2026-11-01'); setValue(byLabel('Likelihood'), '75'); setValue(byLabel('Reason'), 'Waiting on budget'); });
    await act(async () => { button('Move to Potential Orders').click(); });
    await settle();
    expect(calls.at(-1)).toMatchObject({ method: 'POST', body: { expectedDate: '2026-11-01', likelihoodPct: 75, reason: 'Waiting on budget' } });
    expect(onMoved).toHaveBeenCalledWith('POT-2026-0001');
  });

  it("isn't offered to people who can't change bookkeeping", async () => {
    localStorage.setItem('currentUser', JSON.stringify({ role: 'engineer' }));
    await act(async () => { root.render(<MoveToPotential source="order" id={1} number="SO-1" status="DRAFT" onMoved={() => {}} onError={() => {}} />); });
    expect(host.textContent).toBe('');
  });
});

describe('Potential Orders tab', () => {
  const pot = { id: 1, number: 'POT-2026-0001', clientId: 3, clientName: 'Island House Trading', currency: 'ZAR', status: 'OPEN', total: 70781.47, subtotal: 61549.1, taxTotal: 9232.37,
    likelihoodPct: 50, expectedDate: '2026-10-01', reason: 'Waiting on budget', notes: null, sourceType: 'invoice', sourceNumber: 'INV-2026-0005', createdAt: '2026-10-15T08:00:00Z', createdBy: 'dylan',
    lines: [{ partNumber: 'SOFT-001', description: 'Software Bundle', quantity: 1, unitPrice: 7000, taxRateId: 1, taxInclusive: false }] };
  const props = { clients: [{ id: 3, clientName: 'Island House Trading' }], items: [], taxRates: [{ id: 1, name: 'Standard VAT (15%)', rate: 15, isDefault: true }], triggerToast: vi.fn(), refresh: vi.fn(async () => {}) } as any;

  it('shows the open value, weighted value and a decision that has come due', async () => {
    responses['GET /api/potential-orders'] = [pot];
    await act(async () => { root.render(<PotentialOrdersTab {...props} />); });
    await settle();
    expect(host.textContent).toContain('R70');
    expect(host.textContent).toContain('R35'); // weighted at 50%
    const row = host.querySelector('[data-testid="potential-1"]')!.textContent!;
    expect(row).toContain('From invoice INV-2026-0005');
    expect(row).toContain('(due)');
  });

  it('confirms it as a draft invoice, keeping edits made in the window', async () => {
    responses['GET /api/potential-orders'] = [pot];
    responses['POST /api/potential-orders/1/won'] = { outcomeDocNumber: 'INV-2026-0006' };
    window.confirm = () => true;
    const { setConfirmHandler } = await import('../../lib/confirmDialog') as any;
    setConfirmHandler?.(async () => true);
    await act(async () => { root.render(<PotentialOrdersTab {...props} />); });
    await settle();
    await act(async () => { (host.querySelector('[data-testid="potential-1"]') as HTMLElement).click(); });
    await act(async () => { setValue(byLabel('Likelihood'), '90'); });
    await act(async () => { button('Invoice (draft)').click(); });
    await settle();
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put).toMatchObject({ url: '/api/potential-orders/1', body: { likelihoodPct: 90 } });
    expect(calls.find((c) => c.url === '/api/potential-orders/1/won')!.body).toEqual({ as: 'invoice' });
  });
});

describe('client history', () => {
  it('lists events and documents, and adds a call with a follow-up', async () => {
    responses['GET /api/clients/3/history'] = [
      { at: '2026-10-15T08:00:00Z', kind: 'system', title: 'Invoice INV-2026-0005 moved to Potential Order POT-2026-0001.', detail: null, docNumber: 'POT-2026-0001', amount: null, currency: null, by: 'dylan', eventId: 2, followUpDate: null, followUpDone: false },
      { at: '2026-08-18T08:00:00Z', kind: 'invoice', title: 'Invoice INV-2026-0005', detail: 'Now void', docNumber: 'INV-2026-0005', amount: 70781.47, currency: 'ZAR', by: null, eventId: null, followUpDate: null, followUpDone: false },
    ];
    await act(async () => { root.render(<ClientHistory clientId={3} onError={() => {}} />); });
    await settle();
    expect(host.querySelector('[data-testid="client-history"]')!.textContent).toContain('moved to Potential Order POT-2026-0001');
    await act(async () => { setValue(byLabel('Note'), 'Spoke to Sam, revised price by Friday'); setValue(byLabel('Follow-up date'), '2026-10-17'); });
    await act(async () => { button('Add to history').click(); });
    await settle();
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ url: '/api/clients/3/events', body: { kind: 'call', body: 'Spoke to Sam, revised price by Friday', followUpDate: '2026-10-17' } });
  });
});

describe('Dashboard follow-ups', () => {
  it('lists follow-ups and decisions due, and ticks one off; hidden when nothing is due', async () => {
    responses['GET /api/follow-ups'] = { notes: [{ id: 9, clientId: 3, clientName: 'Island House Trading', kind: 'call', body: 'Revised price', followUpDate: '2026-01-01', by: 'dylan' }], decisions: [] };
    await act(async () => { root.render(<FollowUpsCard />); });
    await settle();
    expect(host.textContent).toContain('Island House Trading');
    await act(async () => { (host.querySelector('[aria-label="Mark the Island House Trading follow-up done"]') as HTMLButtonElement).click(); });
    await settle();
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({ url: '/api/client-events/9', body: { followUpDone: true } });

    responses['GET /api/follow-ups'] = { notes: [], decisions: [] };
    await act(async () => { root.render(<FollowUpsCard key="again" />); });
    await settle();
    expect(host.querySelector('[data-testid="follow-ups"]')).toBeNull();
  });
});
