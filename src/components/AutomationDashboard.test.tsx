import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AutomationDashboard, { describeEvent, lastRunText } from './views/AutomationDashboard';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('../lib/confirmDialog', () => ({ confirmDialog: async () => true }));
vi.mock('../components/AutoPoPanel', () => ({ default: () => null }));

let host: HTMLDivElement; let root: Root; let calls: Array<{ method: string; url: string; body: any }>;
const RULE = {
  id: 4, ruleName: 'Out of stock', description: null, triggerEvent: 'OUT_OF_STOCK', triggerLabel: 'An item is out of stock', conditions: { prefix: 'CAP-' },
  action: { type: 'NOTIFY', to: 'everyone' }, every: 'day', isActive: true,
  lastRunAt: '2026-10-27T08:15:00Z', lastResult: { status: 'SUCCESS', by: 'schedule', error: null, total: 25, fresh: 3, notified: true, drafted: [] },
};
const JOBS = [
  { key: 'automation-rules', name: 'Automation rules', description: 'Runs each active rule that is due.', schedule: 'Every hour', runNow: true, scheduled: true, isActive: true, running: false, lastRunAt: null, lastStatus: null, lastMessage: null, lastBy: null, lastMs: null },
  { key: 'bulk-pricing', name: 'Bulk pricing', description: 'Re-prices items.', schedule: 'Daily at 04:30 SA time', runNow: false, scheduled: true, isActive: true, running: false, lastRunAt: '2026-10-27T02:30:00Z', lastStatus: 'FAILED', lastMessage: 'DigiKey said 429', lastBy: 'schedule', lastMs: 10 },
];
beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
    const ok = (b: any) => ({ ok: true, json: async () => b }) as any;
    if (url === '/api/automation-rules' && method === 'GET') return ok([RULE]);
    if (url === '/api/scheduled-jobs') return ok(JOBS);
    if (url === '/api/notifications/unread-count') return ok({ unread: 2 });
    if (url.startsWith('/api/event-log/types')) return ok([{ type: 'RULE_RUN', count: 1 }]);
    if (url.startsWith('/api/event-log')) return ok([]);
    if (url === '/api/automation/options') return ok({
      triggers: [{ key: 'LOW_STOCK', label: 'An item is low on stock', items: true }, { key: 'OUT_OF_STOCK', label: 'An item is out of stock', items: true }, { key: 'INVOICE_OVERDUE', label: 'An invoice is overdue', items: false }, { key: 'AUTO_PO_DUE', label: 'A watched Auto-PO item is at its reorder point', items: true }],
      every: [{ key: 'hour', label: 'Every hour' }, { key: 'day', label: 'Every day' }, { key: 'week', label: 'Every week' }],
    });
    if (url === '/api/automation-rules/4/run') return ok({ total: 25, fresh: 1, notified: true, drafted: [] });
    if (url === '/api/automation-rules/4/preview') return ok({ total: 2, fresh: 1, hits: [{ id: 'CAP-002', label: 'CAP-002', detail: '100NF' }, { id: 'CAP-038', label: 'CAP-038', detail: '100UF' }] });
    if (url.startsWith('/api/notifications?mine=1')) return ok([{ id: 9, notificationType: 'OUT_OF_STOCK', recipient: 'everyone', subject: 'Out of stock: 3 items are out of stock', message: 'CAP-002 (100NF).', read: false, createdAt: '2026-10-27T08:15:00Z' }]);
    return ok({ ok: true, status: 'SUCCESS', message: 'Done.' });
  }));
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;
const tab = (name: string) => [...host.querySelectorAll('[role="tab"]')].find((b) => b.textContent?.startsWith(name)) as HTMLButtonElement;
const render = async (role = 'admin') => { await act(async () => { root.render(<AutomationDashboard triggerToast={() => {}} userRole={role} />); }); };
const select = (label: string, value: string) => act(() => {
  const el = host.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;
  el.value = value; el.dispatchEvent(new Event('change', { bubbles: true }));
});

describe('Automation', () => {
  it('the overview shows what ran and what failed', async () => {
    await render();
    expect(tab('Notifications').textContent).toBe('Notifications (2)');
    expect(host.textContent).toContain('25 found, 3 new, told people');
    expect(host.querySelector('[data-testid="automation-problems"]')!.textContent).toContain('Bulk pricing failed');
  });

  it('a rule says what it does, shows what it finds, and runs now', async () => {
    await render();
    await act(async () => { tab('Automation Rules').click(); });
    const card = host.querySelector('[data-rule="Out of stock"]')!;
    expect(card.textContent).toContain('When an item is out of stock (codes starting CAP-): tell everyone, every day.');
    await act(async () => { button('What it finds').click(); });
    expect(host.querySelector('[data-testid="rule-preview"]')!.textContent).toContain('Right now it finds 2; 1 would be new');
    await act(async () => { button('Run now').click(); });
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/automation-rules/4/run')).toBe(true);
  });

  it('a ready-made rule fills the form; drafting purchase orders only goes with Auto-PO', async () => {
    await render();
    await act(async () => { tab('Automation Rules').click(); });
    // Out of stock is already there, so it isn't offered again
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Out of stock: tell me daily')).toBe(false);
    await act(async () => { button('Overdue invoices: tell the admins').click(); });
    expect((host.querySelector('input[aria-label="Rule name"]') as HTMLInputElement).value).toBe('Overdue invoices');
    expect(host.querySelector('input[aria-label="Only codes starting with"]')).toBeNull(); // not about items
    expect([...(host.querySelector('select[aria-label="Then"]') as HTMLSelectElement).options].map((o) => o.value)).toEqual(['NOTIFY']);
    await act(async () => { button('Save').click(); });
    expect(calls.find((c) => c.method === 'POST' && c.url === '/api/automation-rules')!.body).toEqual({
      ruleName: 'Overdue invoices', description: '', triggerEvent: 'INVOICE_OVERDUE', conditions: { prefix: '' }, action: { type: 'NOTIFY', to: 'role:admin' }, every: 'day', isActive: true,
    });
  });

  it('a new rule to one person, run by hand only', async () => {
    await render();
    await act(async () => { tab('Automation Rules').click(); });
    await act(async () => { button('New rule').click(); });
    const name = host.querySelector('input[aria-label="Rule name"]') as HTMLInputElement;
    act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Watched'); name.dispatchEvent(new Event('input', { bubbles: true })); });
    select('When', 'AUTO_PO_DUE');
    select('Then', 'DRAFT_PO');
    select('How often', '');
    await act(async () => { button('Save').click(); });
    expect(calls.find((c) => c.method === 'POST' && c.url === '/api/automation-rules')!.body).toMatchObject({ triggerEvent: 'AUTO_PO_DUE', action: { type: 'DRAFT_PO' }, every: null });
  });

  it('viewers see rules but cannot change them', async () => {
    await render('viewer');
    await act(async () => { tab('Automation Rules').click(); });
    expect(host.textContent).toContain('Only admins and managers can add or change rules.');
    expect([...host.querySelectorAll('button')].some((b) => b.textContent?.includes('Run now'))).toBe(false);
  });

  it('jobs run now, except bulk pricing, and can be turned off', async () => {
    await render();
    await act(async () => { tab('Scheduled Jobs').click(); });
    const rows = [...host.querySelectorAll('[data-job]')];
    expect(rows[1].textContent).toContain('Run it from Pricing');
    expect(rows[1].textContent).toContain('DigiKey said 429');
    await act(async () => { (rows[0].querySelector('button') as HTMLButtonElement).click(); });
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/scheduled-jobs/automation-rules/run')).toBe(true);
    await act(async () => { [...rows[1].querySelectorAll('button')].find((b) => b.textContent === 'Turn off')!.click(); });
    expect(calls.find((c) => c.url === '/api/scheduled-jobs/bulk-pricing/toggle')!.body).toEqual({ active: false });
  });

  it('notifications: the unread inbox, mark all read', async () => {
    await render();
    await act(async () => { tab('Notifications').click(); });
    expect(host.querySelector('[data-notification="9"]')!.textContent).toContain('Out of stock: 3 items are out of stock');
    await act(async () => { button('Mark all read').click(); });
    expect(calls.some((c) => c.method === 'PUT' && c.url === '/api/notifications/mark-all-read')).toBe(true);
  });

  it('words events and last runs', () => {
    const e = (over: any) => ({ id: 1, eventType: 'RULE_RUN', entityType: null, entityId: '4', action: 'SCHEDULED', userId: 'schedule', details: { total: 5, fresh: 2, notified: true }, status: 'SUCCESS', errorMessage: null, createdAt: '', ...over });
    const rule = (id: string) => (id === '4' ? 'Out of stock' : undefined);
    expect(describeEvent(e({}), rule, () => undefined)).toBe('Rule "Out of stock" ran on schedule: 5 found, 2 new, people told');
    expect(describeEvent(e({ eventType: 'JOB_RUN', entityId: 'exchange-rate', action: 'BY_HAND', details: { message: 'Rates updated.' } }), rule, () => 'Exchange rates')).toBe('Exchange rates (run by hand): Rates updated.');
    expect(describeEvent(e({ eventType: 'AUTO_PO_CREATED', details: '{"poNumber":"PO-2026-0004","lines":[1,2]}' }), rule, () => undefined)).toBe('Auto-PO drafted PO-2026-0004 (2 lines)');
    expect(lastRunText({ ...RULE, lastRunAt: null } as any)).toBe('Not run yet.');
    expect(lastRunText({ ...RULE, lastResult: { status: 'FAILED', by: 'a@b.c', error: 'boom' } } as any)).toMatch(/^Failed .* \(by a@b.c\): boom$/);
  });
});
