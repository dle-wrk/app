import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BulkPricingWizard from './BulkPricingWizard';
import { ConfirmOptions, setConfirmHandler } from '../lib/confirmDialog';

// Drives the real Bulk pricing screen against a scripted API. A run's
// progress is a sequence of answers to GET /api/pricing/bulk-runs/:id, so a
// test can play out "running, running, finished" the way the server would.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const ago = (ms: number) => new Date(now - ms).toISOString();

const SETTINGS = { autoEnabled: true, autoThresholdDays: 35, historyRetentionDays: 40, autoBatchSize: 100, retryFailedAfterDays: 7, qty: 1000, suspiciousAboveUsd: 50 };
const ITEMS = [
  { serialNumber: 'CAP-001', name: '100nF', partNumber: 'CL10B104KB8NNNC', bulkPriceZar: 0.0693, bulkPriceUsd: 0.0042,
    lastAttemptAt: ago(40 * DAY), lastSuccessAt: ago(40 * DAY), lastRunId: 3, lastSource: 'auto', lastStatus: 'updated',
    lastOldPriceZar: 0.07, lastNewPriceZar: 0.0693, lastError: null, due: true, nextDueAt: null },
  { serialNumber: 'CON-002', name: 'Header', partNumber: 'HX20007-5AWB', bulkPriceZar: 1.65, bulkPriceUsd: 0.1,
    lastAttemptAt: ago(2 * DAY), lastSuccessAt: ago(10 * DAY), lastRunId: 4, lastSource: 'manual', lastStatus: 'no_price',
    lastOldPriceZar: null, lastNewPriceZar: null, lastError: 'No price found (mouser: No match found)', due: false, nextDueAt: new Date(now + 25 * DAY - 60_000).toISOString() },
  { serialNumber: 'MISC-001', name: 'Sticker', partNumber: null, bulkPriceZar: null, bulkPriceUsd: null,
    lastAttemptAt: null, lastSuccessAt: null, lastRunId: null, lastSource: null, lastStatus: null,
    lastOldPriceZar: null, lastNewPriceZar: null, lastError: null, due: false, nextDueAt: null },
];
const statusReply = (over: Record<string, unknown> = {}) => ({
  items: ITEMS, total: 3, limit: 100, offset: 0,
  counts: { all: 547, due: 360, problems: 4, never: 364, missing: 52, noPartNumber: 179 },
  settings: SETTINGS, warnings: [], nextAutoRunAt: new Date(now + 5 * 3_600_000).toISOString(), running: null, lastAutoRun: null, ...over,
});
const run = (over: Record<string, unknown> = {}) => ({
  id: 7, trigger: 'manual', scope: 'due', dryRun: false, qty: 1000, status: 'running', stopRequested: false, stale: false,
  requestedBy: 'buyer@example.com', startedAt: ago(60_000), finishedAt: null,
  total: 3, checked: 0, updated: 0, unchanged: 0, flagged: 0, noPrice: 0, skipped: 0, failed: 0, error: null, note: null, ...over,
});
const runItem = (over: Record<string, unknown>) => ({
  id: 1, runId: 7, serialNumber: 'CAP-001', name: '100nF', partNumber: 'CL10B104KB8NNNC', source: 'manual', dryRun: false, status: 'updated',
  oldPriceZar: 0.07, newPriceZar: 0.0693, oldPriceUsd: null, newPriceUsd: 0.0042, provider: 'lcsc', matchedPart: 'C1591',
  nativePrice: 0.0042, nativeCurrency: 'USD', reason: null, at: ago(1000), ...over,
});

type Call = { method: string; path: string; query: URLSearchParams; body?: any };
let calls: Call[];
let server: {
  status: ReturnType<typeof statusReply>;
  runs: any[];
  // Each GET of a run takes the next answer; the last one repeats.
  details: Record<number, any[]>;
  start: { status: number; body: unknown };
  stop: { status: number; body: unknown };
  put: { status: number; body: unknown };
  history: Record<string, unknown>;
};
let confirms: ConfirmOptions[];
let confirmAnswer: boolean;
const toast = vi.fn();
const pricesUpdated = vi.fn();
let host: HTMLDivElement;
let root: Root;

const reply = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as unknown as Response;

beforeEach(() => {
  calls = [];
  server = {
    status: statusReply(),
    runs: [],
    details: {},
    start: { status: 202, body: { runId: 7 } },
    stop: { status: 200, body: { ok: true, message: 'The run will stop after the item it is pricing now.' } },
    put: { status: 200, body: { settings: SETTINGS, warnings: [] } },
    history: {},
  };
  confirms = [];
  confirmAnswer = true;
  toast.mockClear();
  pricesUpdated.mockClear();
  setConfirmHandler(async (opts) => { confirms.push(opts); return confirmAnswer; });
  localStorage.setItem('currentUser', JSON.stringify({ email: 'user@example.com', role: 'user' }));
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://app.test');
    const method = (init?.method || 'GET').toUpperCase();
    calls.push({ method, path: url.pathname, query: url.searchParams, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const route = `${method} ${url.pathname}`;
    let m: RegExpMatchArray | null;
    if (route === 'GET /api/pricing/bulk-status') return reply(server.status);
    if (route === 'GET /api/pricing/bulk-runs') return reply({ runs: server.runs });
    if (route === 'POST /api/pricing/bulk-runs') return reply(server.start.body, server.start.status);
    if (route === 'PUT /api/pricing/bulk-settings') return reply(server.put.body, server.put.status);
    if (method === 'POST' && /^\/api\/pricing\/bulk-runs\/\d+\/stop$/.test(url.pathname)) return reply(server.stop.body, server.stop.status);
    if (method === 'GET' && (m = url.pathname.match(/^\/api\/pricing\/bulk-runs\/(\d+)$/))) {
      const seq = server.details[Number(m[1])];
      if (!seq?.length) return reply({ error: 'Run not found.' }, 404);
      return reply(seq.length > 1 ? seq.shift() : seq[0]);
    }
    if (method === 'GET' && (m = url.pathname.match(/^\/api\/pricing\/bulk-status\/(.+)\/history$/))) {
      const serial = decodeURIComponent(m[1]);
      return reply(server.history[serial] ?? { serialNumber: serial, retentionDays: 40, history: [] });
    }
    return reply({ error: `unexpected ${route}` }, 500);
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

const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function waitFor(check: () => boolean, label: string) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  }
  throw new Error(`timed out waiting for ${label}`);
}
async function render() {
  await act(async () => {
    root.render(<BulkPricingWizard onShowNotification={toast} onPricesUpdated={pricesUpdated} pollIntervalMs={5} />);
  });
  await waitFor(() => !!host.querySelector('tr[data-serial]'), 'the log');
}

const row = (serial: string) => host.querySelector(`tr[data-serial="${serial}"]`) as HTMLTableRowElement;
const button = (label: string | RegExp) => Array.from(host.querySelectorAll('button'))
  .find((b) => (typeof label === 'string' ? b.textContent?.trim() === label : label.test(b.textContent?.trim() ?? ''))) as HTMLButtonElement;
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); await settle(); };
const choose = async (select: HTMLSelectElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
};
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
};
const statusCalls = () => calls.filter((c) => c.method === 'GET' && c.path === '/api/pricing/bulk-status');
const lastStatusQuery = () => statusCalls().at(-1)!.query;
const starts = () => calls.filter((c) => c.method === 'POST' && c.path === '/api/pricing/bulk-runs');
const text = (el: Element | null) => (el?.textContent ?? '').replace(/ /g, ' ');
const runCard = () => host.querySelector('[data-testid="run-card"]');

describe('the log', () => {
  it("shows each item's last bulk pricing and when it is next due", async () => {
    await render();

    expect(text(row('CAP-001'))).toContain('Updated');
    expect(text(row('CAP-001'))).toContain('40 days ago · automatic');
    expect(text(row('CAP-001'))).toContain('Due now');
    expect(text(row('CAP-001'))).toMatch(/R0\.0700 → R0\.0693/);
    expect(text(row('CON-002'))).toContain('No price');
    expect(text(row('CON-002'))).toContain('No price found (mouser: No match found)');
    expect(text(row('CON-002'))).toContain('Due in 25 days');
    expect(text(row('MISC-001'))).toContain('No part number');
    expect(text(row('MISC-001'))).toContain('Never');
    expect(button(/^Due \(/).textContent).toBe('Due (360)');
    expect(text(host.querySelector('[data-testid="auto-summary"]')))
      .toContain('Automatic: items last priced more than 35 days ago are re-priced daily, up to 100 per run.');
    expect(text(host.querySelector('[data-testid="auto-summary"]'))).toContain('No automatic run yet.');
    const scope = host.querySelector('select[aria-label="Items to price"]') as HTMLSelectElement;
    expect(scope.value).toBe('due');
    expect(Array.from(scope.options).map((o) => text(o))).toEqual([
      'Items due for re-pricing (360)', 'Items with no bulk price (52)', 'Every item with a part number (368)', 'Ticked items (0)',
    ]);
  });

  it('filters, sorts, searches and pages through the API', async () => {
    server.status = statusReply({ total: 250 });
    await render();

    await click(button(/^Problems/));
    expect(lastStatusQuery().get('filter')).toBe('problems');

    await choose(host.querySelector('select[aria-label="Sort"]') as HTMLSelectElement, 'recent');
    expect(lastStatusQuery().get('sort')).toBe('recent');

    await type(host.querySelector('input[aria-label="Search items"]') as HTMLInputElement, ' CAP ');
    await waitFor(() => lastStatusQuery().get('search') === 'CAP', 'the search');
    expect(lastStatusQuery().get('filter')).toBe('problems');

    await click(host.querySelector('button[aria-label="Next page"]')!);
    expect(lastStatusQuery().get('offset')).toBe('100');
    expect(lastStatusQuery().get('limit')).toBe('100');
  });

  it("shows an item's price history", async () => {
    server.history['CAP-001'] = { serialNumber: 'CAP-001', retentionDays: 40, history: [
      runItem({ id: 9, runId: 3, source: 'auto', oldPriceZar: 0.07, newPriceZar: 0.0693, provider: 'lcsc' }),
      runItem({ id: 4, runId: 1, status: 'no_price', oldPriceZar: 0.07, newPriceZar: null, provider: null, reason: 'No price found' }),
    ] };
    await render();

    await click(row('CAP-001').querySelector('button')!);
    await waitFor(() => !!host.querySelector('[data-testid="item-history"]'), 'the history');

    const history = host.querySelector('[data-testid="item-history"]')!;
    expect(text(history)).toContain('Bulk pricing history of CAP-001, kept for 40 days.');
    const rows = Array.from(history.querySelector('table')!.tBodies[0].rows).map((r) => text(r));
    expect(rows[0]).toMatch(/#3 · automatic.*Updated.*R0\.0700.*R0\.0693.*lcsc/);
    expect(rows[1]).toMatch(/#1 · manual.*No price.*R0\.0700.*—.*No price found/);
  });

  it('warns when history would not cover a re-price cycle', async () => {
    server.status = statusReply({ warnings: ['History is kept for 30 days but items are re-priced after 35, so the record of each item\'s previous change will be gone before it is re-priced.'] });
    await render();

    expect(text(host)).toContain('History is kept for 30 days but items are re-priced after 35');
  });
});

describe('running bulk pricing', () => {
  it('previews the due items, follows the run, and shows why items were not updated', async () => {
    server.details[7] = [
      run({ dryRun: true, checked: 1 }),
      run({ dryRun: true, status: 'completed', checked: 3, updated: 1, unchanged: 1, noPrice: 1, finishedAt: ago(0), note: 'Preview only: nothing was written.' }),
    ];
    const finished = { run: server.details[7][1], reasons: [{ status: 'no_price', reason: 'No price found', count: 1 }], items: [
      runItem({ dryRun: true }),
      runItem({ id: 2, serialNumber: 'CON-002', name: 'Header', status: 'no_price', oldPriceZar: 1.65, newPriceZar: null, provider: null, reason: 'No price found (mouser: No match found)' }),
      runItem({ id: 3, serialNumber: 'RES-005', name: '10k', status: 'unchanged', oldPriceZar: 0.02, newPriceZar: 0.02, provider: 'mouser' }),
    ] };
    server.details[7] = [{ run: server.details[7][0], reasons: [], items: [] }, finished];
    await render();

    await click(button('Preview'));

    // 360 items: big enough to ask first, as it uses supplier API calls.
    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toMatchObject({ title: 'Preview bulk prices', confirmLabel: 'Preview 360 items' });
    expect(starts().map((c) => c.body)).toEqual([{ scope: 'due', dryRun: true }]);
    await waitFor(() => text(runCard()).includes('Completed'), 'the run to finish');

    expect(text(runCard())).toContain('Preview #7');
    expect(text(host.querySelector('[data-testid="run-counts"]'))).toMatch(/Would change1Unchanged1Held back0No price1Skipped0Failed0/);
    expect(text(host.querySelector('[data-testid="run-reasons"]'))).toContain('1 ×No price found');
    expect(text(runCard())).toContain('Preview only: nothing was written.');
    expect(toast).toHaveBeenCalledWith('Preview #7 completed: 1 price would change, 1 unchanged, 1 not priced (see why below).', 'SUCCESS');
    expect(pricesUpdated).not.toHaveBeenCalled();

    await click(button('Show items (3)'));
    await click(button('Not priced'));
    const items = Array.from((host.querySelector('[data-testid="run-items"]') as HTMLTableElement).tBodies[0].rows).map((r) => text(r));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatch(/CON-002.*No price.*R1\.6500.*No price found \(mouser: No match found\)/);
  });

  it('updates prices after confirmation, then reloads the inventory', async () => {
    server.details[7] = [
      { run: run(), reasons: [], items: [] },
      { run: run({ status: 'completed', checked: 3, updated: 2, unchanged: 1, finishedAt: ago(0) }), reasons: [], items: [] },
    ];
    await render();
    const before = statusCalls().length;

    await click(button('Update prices'));

    expect(confirms[0].title).toBe('Update bulk prices');
    expect(confirms[0].message.replace(/ /g, ' ')).toContain('Re-price 360 items at 1 000 units from the suppliers?');
    expect(confirms[0].message).toContain("Only each item's bulk price (R and $) is written. Stock, part numbers, links and the item's cost are not changed.");
    expect(starts().map((c) => c.body)).toEqual([{ scope: 'due', dryRun: false }]);
    await waitFor(() => pricesUpdated.mock.calls.length === 1, 'the reload');

    expect(toast).toHaveBeenCalledWith('Run #7 completed: 2 prices updated, 1 unchanged.', 'SUCCESS');
    expect(statusCalls().length).toBeGreaterThan(before);
    expect(pricesUpdated).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the confirmation is declined', async () => {
    confirmAnswer = false;
    await render();

    await click(button('Update prices'));

    expect(confirms).toHaveLength(1);
    expect(starts()).toEqual([]);
  });

  it('prices only the ticked items', async () => {
    server.details[7] = [{ run: run({ scope: 'selected', status: 'completed', total: 2, checked: 2, unchanged: 2, finishedAt: ago(0) }), reasons: [], items: [] }];
    await render();

    await click(row('CAP-001').querySelector('input[type="checkbox"]')!);
    await click(row('CON-002').querySelector('input[type="checkbox"]')!);

    const scope = host.querySelector('select[aria-label="Items to price"]') as HTMLSelectElement;
    expect(scope.value).toBe('selected');
    expect(text(scope.selectedOptions[0])).toBe('Ticked items (2)');
    await click(button('Update prices'));

    expect(confirms[0].confirmLabel).toBe('Update 2 items');
    expect(starts().map((c) => c.body)).toEqual([{ scope: 'selected', dryRun: false, serialNumbers: ['CAP-001', 'CON-002'] }]);
    await waitFor(() => toast.mock.calls.length > 0, 'the result');
    expect(pricesUpdated).not.toHaveBeenCalled(); // nothing changed
  });

  it('says so when nothing is due, without asking the server', async () => {
    server.status = statusReply({ counts: { all: 547, due: 0, problems: 0, never: 0, missing: 0, noPartNumber: 179 } });
    await render();

    await click(button('Update prices'));

    expect(toast).toHaveBeenCalledWith('Nothing is due for re-pricing.', 'INFO');
    expect(confirms).toEqual([]);
    expect(starts()).toEqual([]);
  });

  it('says when another run is in progress, and follows that one', async () => {
    server.start = { status: 409, body: { error: 'A bulk pricing run is already in progress (run #5).', runId: 5 } };
    server.details[5] = [{ run: run({ id: 5, trigger: 'auto', checked: 1 }), reasons: [], items: [] }];
    await render();

    await click(button('Update prices'));
    await waitFor(() => !!runCard(), 'the other run');

    expect(toast).toHaveBeenCalledWith('A bulk pricing run is already in progress (run #5).', 'ERROR');
    expect(text(runCard())).toContain('Run #5');
    expect(text(runCard())).toContain('automatic');
    expect(button('Stop')).toBeTruthy();
  });

  it('picks up a run already in progress, and stops it on request', async () => {
    server.status = statusReply({ running: run({ id: 9, checked: 1 }) });
    server.details[9] = [{ run: run({ id: 9, checked: 1 }), reasons: [], items: [] }];
    await render();
    await waitFor(() => !!runCard(), 'the run in progress');

    expect(text(runCard())).toContain('1 of 3 items checked');
    expect(button('Update prices').disabled).toBe(true);
    expect(button('Preview').disabled).toBe(true);
    expect(text(host)).toContain('Run #9 is in progress; a new run can start when it finishes.');

    server.details[9] = [{ run: run({ id: 9, checked: 2, stopRequested: true }), reasons: [], items: [] }];
    await click(button('Stop'));

    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/pricing/bulk-runs/9/stop')).toBe(true);
    expect(toast).toHaveBeenCalledWith('The run will stop after the item it is pricing now.', 'INFO');
    await waitFor(() => text(runCard()).includes('Stopping after the current item'), 'the stop to show');

    server.details[9] = [{ run: run({ id: 9, status: 'stopped', checked: 2, updated: 2, finishedAt: ago(0), note: 'Stopped on request after 2 of 3 items.' }), reasons: [], items: [] }];
    await waitFor(() => text(runCard()).includes('Stopped on request after 2 of 3 items.'), 'the run to stop');
    expect(pricesUpdated).toHaveBeenCalledTimes(1);
    // Free to start again, even before the log catches up with the run's end.
    expect(server.status.running).toMatchObject({ id: 9 });
    expect(button('Update prices').disabled).toBe(false);
  });

  it('opens a past run from the recent runs list', async () => {
    server.runs = [run({ id: 4, status: 'completed_with_errors', checked: 3, updated: 1, failed: 2, finishedAt: ago(DAY - 60_000), startedAt: ago(DAY) })];
    server.details[4] = [{ run: server.runs[0], reasons: [{ status: 'failed', reason: 'Supplier lookup failed: DigiKey token expired', count: 2 }], items: [runItem({ runId: 4 })] }];
    await render();
    await waitFor(() => !!host.querySelector('[data-testid="recent-runs"] tbody tr'), 'the runs list');

    await click(host.querySelector('[data-testid="recent-runs"] tbody tr')!);
    await waitFor(() => !!runCard(), 'the run');

    expect(text(runCard())).toContain('Completed with errors');
    expect(text(runCard())).toContain('2 ×Supplier lookup failed: DigiKey token expired');
    expect((host.querySelector('[data-testid="run-items"]') as HTMLTableElement).tBodies[0].rows).toHaveLength(1);
    expect(toast).not.toHaveBeenCalled(); // an old run is shown, not announced
  });
});

describe('settings', () => {
  it('shows them read-only to anyone but an admin', async () => {
    await render();

    await click(button('Settings'));

    const field = host.querySelector('input[aria-label="Re-price after (days)"]') as HTMLInputElement;
    expect(field.value).toBe('35');
    expect(field.disabled).toBe(true);
    expect(button('Save settings')).toBeUndefined();
    expect(text(host.querySelector('[data-testid="bulk-settings"]'))).toContain('Only an admin can change these.');
  });

  it('lets an admin change them', async () => {
    localStorage.setItem('currentUser', JSON.stringify({ email: 'admin@example.com', role: 'admin' }));
    server.put = { status: 200, body: { settings: { ...SETTINGS, autoThresholdDays: 40 }, warnings: [] } };
    await render();
    await click(button('Settings'));
    expect(button('Save settings').disabled).toBe(true); // nothing changed yet

    await type(host.querySelector('input[aria-label="Re-price after (days)"]') as HTMLInputElement, '40');
    await click(button('Save settings'));

    const put = calls.find((c) => c.method === 'PUT' && c.path === '/api/pricing/bulk-settings');
    expect(put?.body).toEqual({ ...SETTINGS, autoThresholdDays: 40 });
    expect(toast).toHaveBeenCalledWith('Bulk pricing settings saved.');
  });

  it("shows the server's reason when a value is refused", async () => {
    localStorage.setItem('currentUser', JSON.stringify({ email: 'admin@example.com', role: 'admin' }));
    server.put = { status: 400, body: { error: 'Keep history for (days) must be a whole number from 30 to 3650.' } };
    await render();
    await click(button('Settings'));

    await type(host.querySelector('input[aria-label="Keep history for (days)"]') as HTMLInputElement, '7');
    await click(button('Save settings'));

    expect(toast).toHaveBeenCalledWith('Keep history for (days) must be a whole number from 30 to 3650.', 'ERROR');
  });
});
