import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BulkPricingReview, { type ReviewEntry } from './BulkPricingReview';
import { ConfirmOptions, setConfirmHandler } from '../lib/confirmDialog';

// The bulk pricing problem review against a stubbed API.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ANSWERS = [
  { provider: 'mouser', matchedPart: 'PASTERNACK-RF', manufacturer: 'Pasternack', nativePrice: 241, currency: 'USD', zar: 3976.5, usd: 241, stock: 12, breakQty: 1000, url: 'https://mouser/x', error: null },
  { provider: 'digikey', matchedPart: null, manufacturer: null, nativePrice: null, currency: null, zar: null, usd: null, stock: null, breakQty: null, url: null, error: 'DigiKey token refresh failed (401)' },
  { provider: 'lcsc', matchedPart: 'C1591', manufacturer: 'Samsung', nativePrice: 0.0064, currency: 'USD', zar: 0.1056, usd: 0.0064, stock: 1175100, breakQty: 1000, url: null, error: null },
];
const entry = (over: Partial<ReviewEntry> = {}): ReviewEntry => ({
  serialNumber: 'CAP-009', name: '100nF', partNumber: 'CL10B104KB8NNNC', lcscCode: 'C1591', bulkPriceZar: 0.5, bulkPriceUsd: 0.0303,
  problem: 'flagged', reason: 'Cheapest price, 241 USD from mouser (matched PASTERNACK-RF), is above the 50 USD review threshold…', lastAttemptAt: null,
  result: { historyId: 7, status: 'flagged', at: new Date().toISOString(), runId: 5, recheck: false, preview: false, decidedBy: null, provider: 'mouser',
    matchedPart: 'PASTERNACK-RF', proposedZar: 3976.5, proposedUsd: 241, reason: null, answers: ANSWERS },
  ...over,
});
const CON = entry({ serialNumber: 'CON-025', name: 'Connector', partNumber: '15M1810', lcscCode: null, bulkPriceZar: 12, problem: 'no_price', reason: 'No price found (mouser: No match found)', result: null });

let calls: Array<{ method: string; url: string; body?: any }>;
let list: { entries: ReviewEntry[]; counts: Record<string, number> };
let replies: Record<string, { status: number; body: unknown }>;
let confirms: ConfirmOptions[];
let confirmAnswer: boolean;
const toast = vi.fn();
const decided = vi.fn();
const openItem = vi.fn();
let host: HTMLDivElement;
let root: Root;

const reply = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

beforeEach(() => {
  calls = [];
  list = { entries: [entry(), CON], counts: { all: 2, flagged: 1, no_price: 1, failed: 0 } };
  replies = {};
  confirms = [];
  confirmAnswer = true;
  toast.mockClear(); decided.mockClear(); openItem.mockClear();
  setConfirmHandler(async (opts) => { confirms.push(opts); return confirmAnswer; });
  localStorage.setItem('currentUser', JSON.stringify({ email: 'engineer@example.com', role: 'engineer' }));
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || 'GET').toUpperCase();
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const scripted = replies[`${method} ${url}`];
    if (scripted) return reply(scripted.body, scripted.status);
    if (method === 'GET' && url.startsWith('/api/pricing/bulk-review')) return reply(list);
    return reply({ error: `unexpected ${method} ${url}` }, 500);
  }));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  setConfirmHandler(null);
  localStorage.clear();
});

async function render() {
  await act(async () => { root.render(<BulkPricingReview onShowNotification={toast} onDecided={decided} onOpenItem={openItem} />); });
  await settle();
}
const text = (el: Element | null) => (el?.textContent ?? '').replace(/ /g, ' ');
const button = (label: string | RegExp, scope: ParentNode = host) => Array.from(scope.querySelectorAll('button'))
  .find((b) => (typeof label === 'string' ? b.textContent?.trim() === label : label.test(b.textContent?.trim() ?? ''))) as HTMLButtonElement | undefined;
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); await settle(); };
const detail = () => host.querySelector('[data-testid="review-detail"]')!;
const answerRow = (provider: string) => host.querySelector(`[data-provider="${provider}"]`)!;
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
};
const posts = () => calls.filter((c) => c.method === 'POST');

describe('the problem review', () => {
  it("lists the problems and compares every supplier's answer for the first one", async () => {
    await render();

    expect(text(host.querySelector('[data-testid="review-queue"]'))).toMatch(/CAP-009Held back100nFR0\.5000 → R3 976\.50CON-025No priceConnector/);
    expect(text(detail())).toContain('Looked up as CL10B104KB8NNNC · LCSC C1591');
    expect(text(host.querySelector('[data-testid="current-price"]'))).toBe('R0.5000');
    // Cheapest first, then the ones without a price.
    expect(Array.from(host.querySelectorAll('[data-provider]')).map((r) => r.getAttribute('data-provider'))).toEqual(['lcsc', 'mouser', 'digikey']);
    expect(text(answerRow('lcsc'))).toMatch(/LCSCcheapestC1591Samsung\$0\.0064at 1 000\+R0\.1056-79%1 175 100Use this price/);
    expect(text(answerRow('mouser'))).toMatch(/Mouserheld backPASTERNACK-RF.*R3 976\.50×7 953/);
    expect(text(answerRow('digikey'))).toContain('DigiKey token refresh failed (401)');
  });

  it("approves a supplier's price after confirmation, then moves on to the next problem", async () => {
    replies['POST /api/pricing/bulk-review/CAP-009/approve'] = { status: 200, body: { decision: 'approved', changed: true, newPriceZar: 0.1056 } };
    await render();

    await click(button('Use this price', answerRow('lcsc'))!);

    expect(confirms[0]).toMatchObject({ title: 'Approve this price', confirmLabel: 'Approve price' });
    expect(confirms[0].message).toContain("Set CAP-009's bulk price to R0.1056 ($0.0064) from LCSC, which matched C1591?");
    expect(posts()[0].body).toEqual({ historyId: 7, provider: 'lcsc' });
    expect(toast).toHaveBeenCalledWith('CAP-009: bulk price set to R0.1056 from LCSC.', 'SUCCESS');
    expect(decided).toHaveBeenCalledWith(true);
    expect(text(detail())).toContain('CON-025');
  });

  it('does nothing when the approval is declined', async () => {
    confirmAnswer = false;
    await render();

    await click(button('Use this price', answerRow('mouser'))!);

    expect(posts()).toEqual([]);
  });

  it('reloads when the result went stale', async () => {
    replies['POST /api/pricing/bulk-review/CAP-009/approve'] = { status: 409, body: { error: 'There is a newer result for this item. Reload it and check again.' } };
    await render();
    const gets = calls.filter((c) => c.method === 'GET').length;

    await click(button('Use this price', answerRow('lcsc'))!);

    expect(toast).toHaveBeenCalledWith('There is a newer result for this item. Reload it and check again.', 'ERROR');
    expect(calls.filter((c) => c.method === 'GET').length).toBe(gets + 1);
    expect(decided).not.toHaveBeenCalled();
  });

  it('keeps the current price, with the reason given', async () => {
    replies['POST /api/pricing/bulk-review/CAP-009/reject'] = { status: 200, body: { decision: 'rejected', changed: false } };
    await render();

    await type(host.querySelector('input[aria-label="Reason (optional)"]') as HTMLInputElement, 'Mouser matched an RF part');
    await click(button('Keep current price')!);

    expect(posts()[0]).toMatchObject({ url: '/api/pricing/bulk-review/CAP-009/reject', body: { note: 'Mouser matched an RF part' } });
    expect(toast).toHaveBeenCalledWith('CAP-009: kept the current price (R0.5000).', 'SUCCESS');
    expect(decided).toHaveBeenCalledWith(false);
  });

  it('sets a price by hand', async () => {
    replies['POST /api/pricing/bulk-review/CAP-009/price'] = { status: 200, body: { decision: 'manual', changed: true, newPriceZar: 0.12, newPriceUsd: 0.0073 } };
    await render();

    await click(button('Set price by hand')!);
    await type(host.querySelector('#manual-price') as HTMLInputElement, '0,12');
    await click(button('Save price')!);

    expect(posts()[0].body).toEqual({ zar: 0.12 });
    expect(toast).toHaveBeenCalledWith('CAP-009: bulk price set by hand to R0.1200 ($0.0073).', 'SUCCESS');
  });

  it('asks the suppliers again and shows their new answers', async () => {
    await render();
    await click(button('CON-025', host.querySelector('[data-testid="review-queue"]')!) ?? host.querySelectorAll('[data-testid="review-queue"] button')[1]);
    expect(text(detail())).toContain("The suppliers' answers weren't kept for this result. Re-check now to see them side by side.");
    replies['POST /api/pricing/bulk-review/CON-025/recheck'] = { status: 200, body: { entry: { ...CON, result: { ...entry().result!, historyId: 9, recheck: true, decidedBy: 'engineer@example.com', status: 'offer', answers: [ANSWERS[2]] } } } };

    await click(button('Re-check now')!);

    expect(toast).toHaveBeenCalledWith('CON-025: suppliers asked again. Compare their answers below.', 'INFO');
    expect(text(detail())).toMatch(/Re-checked .* by engineer@example\.com/);
    expect(host.querySelectorAll('[data-provider]')).toHaveLength(1);
  });

  it('leaves an item out of bulk pricing after confirmation', async () => {
    replies['POST /api/pricing/bulk-review/CAP-009/exclude'] = { status: 200, body: { serialNumber: 'CAP-009', excluded: true } };
    await render();

    await click(button('Leave out of bulk pricing')!);

    expect(confirms[0].title).toBe('Leave out of bulk pricing');
    expect(posts()[0].body).toEqual({ excluded: true });
    expect(toast).toHaveBeenCalledWith('CAP-009 is left out of bulk pricing.', 'SUCCESS');
  });

  it('steps through the problems and opens an item', async () => {
    await render();

    await click(host.querySelector('button[aria-label="Next item"]')!);
    expect(text(detail())).toContain('CON-025');
    await click(button('Open item / edit part numbers')!);
    expect(openItem).toHaveBeenCalledWith('CON-025');
  });

  it('lets a viewer compare but not decide', async () => {
    localStorage.setItem('currentUser', JSON.stringify({ email: 'viewer@example.com', role: 'viewer' }));
    await render();

    expect(host.querySelector('[data-testid="answers"]')).toBeTruthy();
    expect(button('Use this price')).toBeUndefined();
    expect(host.querySelector('[data-testid="review-actions"]')).toBeNull();
    expect(text(host)).toContain('Only admins, managers and engineers can change inventory, prices and part numbers. You can compare the answers.');
  });

  it('shows nothing when there is nothing to review', async () => {
    list = { entries: [], counts: { all: 0, flagged: 0, no_price: 0, failed: 0 } };
    await render();

    expect(host.querySelector('[data-testid="bulk-review"]')).toBeNull();
  });
});
