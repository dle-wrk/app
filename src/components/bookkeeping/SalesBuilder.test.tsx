import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SalesBuilderTab } from './SalesBuilderTab';
import { LineItemsEditor, type EditableLine } from './LineItemsEditor';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ url: string; method: string; body: any }>;
const taxRates = [{ id: 1, name: 'Standard VAT (15%)', rate: 15, isDefault: true }, { id: 3, name: 'Exempt', rate: 0 }] as any;
const items = [
  { partNumber: 'BAT-5K', name: '5kWh Battery', price: 900, bulkPriceZar: 15000, status: 'ACTIVE' },
  { partNumber: 'OLD-1', name: 'Old part', price: 1, status: 'DO NOT USE' },
] as any;
const kit = {
  id: 1, name: 'Solar Kit A', category: 'Solar', tags: ['5kW'], clientId: null, clientName: null, discountPct: 5, notes: 'Includes 5-year warranty',
  active: true, updatedAt: '2026-10-15T08:00:00Z', updatedBy: 'a@x.com',
  lines: [{ kind: 'item', ref: 'BAT-5K', description: '5kWh Battery', quantity: 2, unitPrice: 22000, taxRateId: 1 }],
  totals: { gross: 44000, discount: -2200, total: 41800, cost: 30000, costKnown: true, marginPct: 28.2 }, warnings: [], error: null,
};
const forAcme = { ...kit, id: 2, name: 'Acme spares', clientId: 7, clientName: 'Acme', discountPct: 0, notes: null, category: 'Spares', tags: [] };

beforeEach(() => {
  calls = [];
  localStorage.setItem('currentUser', JSON.stringify({ role: 'admin' }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method || 'GET';
    calls.push({ url: String(url), method, body: init?.body ? JSON.parse(String(init.body)) : null });
    const ok = (data: unknown) => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => data, text: async () => JSON.stringify(data) });
    if (url === '/api/sales-packages' && method === 'GET') return ok([kit, forAcme]);
    if (url === '/api/sales-packages' && method === 'POST') return ok({ id: 3 });
    if (String(url).startsWith('/api/sales-packages/1/expand')) return ok({
      id: 1, name: 'Solar Kit A', notes: 'Includes 5-year warranty', currency: 'ZAR', zarPerUnit: null, warnings: ['OLD-1 is marked Do Not Use.'],
      lines: [
        { kind: 'item', partNumber: 'BAT-5K', description: '5kWh Battery', quantity: 2, unitPrice: 22000, taxRateId: 1 },
        { kind: 'discount', partNumber: null, description: 'Solar Kit A discount (5%)', quantity: 1, unitPrice: -2200, taxRateId: 1 },
      ],
    });
    if (url === '/api/production-products') return ok([{ model_number: 'INV-5K', description: '5kW Inverter', selling_price: 18500, production_cost: 12000 }]);
    if (url === '/api/exchange-rate') return ok({ usdToZar: 18 });
    return ok({});
  }));
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); localStorage.removeItem('currentUser'); });

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const button = (text: RegExp | string) => [...host.querySelectorAll('button')].find((b) => (typeof text === 'string' ? b.textContent?.trim() === text : text.test(b.textContent ?? ''))) as HTMLButtonElement;
const setValue = (el: HTMLInputElement | HTMLSelectElement, v: string) => {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
};
const byLabel = (l: string) => host.querySelector(`[aria-label="${l}"]`) as HTMLInputElement;

describe('Sales Builder', () => {
  it('lists packages with price and margin, and builds a new one: an item at cost + markup, a service, a discount', async () => {
    await act(async () => { root.render(<SalesBuilderTab {...({ clients: [{ id: 7, clientName: 'Acme' }], items, taxRates, triggerToast: vi.fn() } as any)} />); });
    await settle();
    expect(host.querySelector('[data-testid="package-1"]')!.textContent).toContain('R41');
    expect(host.querySelector('[data-testid="package-1"]')!.textContent).toContain('28.2% margin');

    await act(async () => { button(/New package/).click(); });
    await act(async () => { setValue(byLabel('Package name'), 'Battery bundle'); });
    await act(async () => { setValue(byLabel('Line 1 SKU'), 'BAT-5K'); byLabel('Line 1 SKU').dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    expect(byLabel('Line 1 description').value).toBe('5kWh Battery');
    expect(host.textContent).toContain('Cost R15'); // bulk price in rand
    await act(async () => { setValue(byLabel('Markup percent'), '20'); });
    await act(async () => { button('Apply').click(); });
    expect(byLabel('Line 1 price').value).toBe('18000');

    await act(async () => { button('Add line').click(); });
    await act(async () => { setValue(byLabel('Line 2 type'), 'service'); });
    await act(async () => { setValue(byLabel('Line 2 description'), 'Installation'); setValue(byLabel('Line 2 price'), '2000'); });
    await act(async () => { setValue(byLabel('Discount percent'), '10'); });
    const totals = host.querySelector('[data-testid="pkg-totals"]')!.textContent!;
    expect(totals).toContain('R20');   // lines 20 000
    expect(totals).toContain('-R2');   // 10% off
    expect(totals).toContain('R18');   // 18 000 excl. VAT

    await act(async () => { button('Save package').click(); });
    await settle();
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toMatchObject({
      name: 'Battery bundle', discountPct: 10, active: true,
      lines: [
        { kind: 'item', ref: 'BAT-5K', description: '5kWh Battery', quantity: 1, unitPrice: 18000, taxRateId: 1 },
        { kind: 'service', ref: null, description: 'Installation', quantity: 1, unitPrice: 2000, taxRateId: 1 },
      ],
    });
  });
});

describe('Add package on an order', () => {
  it("lists the client's packages first, and puts the package's lines and its notes on the order", async () => {
    let lines: EditableLine[] = [{ key: 'blank', description: '', quantity: 1, unitPrice: 0, taxRateId: 1 }];
    let notes = '';
    const notify = vi.fn();
    const render = () => root.render(<LineItemsEditor lines={lines} onChange={(l) => { lines = l; render(); }} items={items} taxRates={taxRates} mode="SALES" currency="ZAR"
      packages={{ clientId: 7, onNotes: (n) => { notes = n; }, notify }} />);
    await act(async () => { render(); });
    await act(async () => { button(/Add package/).click(); });
    await settle();
    const names = [...host.querySelectorAll('[data-testid="package-picker"] li')].map((li) => li.textContent);
    expect(names[0]).toContain('Acme spares'); // this client's first
    expect(names[0]).toContain('For Acme');

    await act(async () => { (host.querySelector('[aria-label="Add package Solar Kit A"]') as HTMLButtonElement).click(); });
    await settle();
    expect(lines.map((l) => [l.partNumber ?? null, l.description, l.quantity, l.unitPrice])).toEqual([
      ['BAT-5K', '5kWh Battery', 2, 22000],
      [null, 'Solar Kit A discount (5%)', 1, -2200],
    ]); // the untouched blank line is replaced
    expect(notes).toBe('Includes 5-year warranty');
    expect(notify).toHaveBeenCalledWith('Check before sending: OLD-1 is marked Do Not Use.', 'INFO');
    expect(host.querySelector('[data-testid="package-picker"]')).toBeNull();
  });

  it("isn't offered on purchase documents", async () => {
    await act(async () => { root.render(<LineItemsEditor lines={[]} onChange={() => {}} items={items} taxRates={taxRates} mode="PURCHASE" currency="ZAR" packages={{ clientId: null }} />); });
    expect(button(/Add package/)).toBeUndefined();
  });
});
