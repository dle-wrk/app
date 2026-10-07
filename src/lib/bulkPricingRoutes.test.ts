// @vitest-environment node
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The real bulk pricing routes on a real Express app, with the engine running
// for real against the in-memory database stand-in (./bulkPricingFakeDb) and
// scripted supplier quotes. A run started over HTTP carries on in the
// background, so tests follow it the way the page does: by polling the run.

vi.mock('./db', () => ({
  pool: { connect: async () => { throw new Error('the real pool must not be used in tests'); } },
  query: async () => { throw new Error('the real query must not be used in tests'); },
  queryOne: async () => null,
  exec: async () => {},
}));

import { STATUS_FILTERS, STATUS_SORTS, registerBulkPricingRoutes } from './bulkPricingRoutes';
import { DEFAULT_SETTINGS, parseSettings, priceOrNull, type EngineDeps } from './bulkPricing';
import { DAY, fakeDb, type FakeDb } from './bulkPricingFakeDb';

const FX = { usdToZar: 16.5, ratesToZar: { USD: 16.5, ZAR: 1 } };

let db: FakeDb;
let quotes: Record<string, any>;
let quoteCalls: string[];
let hold: Promise<void> | null;
let releaseHold: () => void;
let notified: number;

// Every dependency reads the current test's state at call time.
const deps: EngineDeps = {
  readSettings: async () => {
    const raw = db.state.settings.get('bulkPricing');
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = parseSettings(JSON.parse(raw));
    return 'error' in parsed ? { ...DEFAULT_SETTINGS } : parsed.settings;
  },
  readFx: async () => FX,
  selectItems: async (scope, options) => [...db.state.inventory.entries()]
    .filter(([sn]) => scope !== 'selected' || (options.serialNumbers ?? []).includes(sn))
    .map(([sn, r]) => ({ serialNumber: sn, name: r.name, partNumber: r.man_pn_1 ?? null, lcscCode: r.lcsc_code ?? null, bulkPriceZar: priceOrNull(r.bulk_price_zar), bulkPriceUsd: priceOrNull(r.bulk_price_usd) })),
  quote: async (partNumber) => {
    quoteCalls.push(partNumber);
    if (hold) await hold;
    return { partNumber, qty: 1000, codeFormat: 'mfn', ...(quotes[partNumber] ?? { mouser: { unitPrice: 0.1, currency: 'USD', partNumber } }) };
  },
  connect: async () => ({ query: (t: string, p?: any[]) => db.run(t, p), release: () => {} }) as any,
  query: (t, p) => db.run(t, p),
  sleep: async () => {},
  notifyChanged: async () => { notified += 1; },
};

let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Stand-in for attachSessionUser: the test names the caller's role.
  app.use('/api', (req: any, _res, next) => {
    const role = req.headers['x-test-role'];
    if (role) req.user = { id: 1, email: `${role}@example.com`, role: String(role) };
    next();
  });
  registerBulkPricingRoutes(app, deps);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));

beforeEach(() => {
  db = fakeDb(Date.now());
  quotes = {};
  quoteCalls = [];
  hold = null;
  notified = 0;
});

// An engineer may change inventory (and so run bulk pricing); see ./permissions.
const call = async (method: string, path: string, body?: unknown, role = 'engineer') => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(role ? { 'x-test-role': role } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

function addItem(sn: string, partNumber: string | null, zar: string | null = null) {
  db.state.inventory.set(sn, { name: `${sn} name`, man_pn_1: partNumber, bulk_price_zar: zar, bulk_price_usd: null, stock: 7 });
}

function holdQuotes() {
  hold = new Promise<void>((resolve) => { releaseHold = () => { hold = null; resolve(); }; });
}

async function waitForRun(id: number) {
  for (let i = 0; i < 400; i++) {
    const { body } = await call('GET', `/api/pricing/bulk-runs/${id}`);
    if (body.run?.status !== 'running') return body;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`run #${id} did not finish`);
}

const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('POST /api/pricing/bulk-runs', () => {
  it('lets only roles that may change inventory start or stop a run', async () => {
    addItem('A', 'PN-A');
    const refused = { error: 'Only admins, managers and engineers can change inventory, prices and part numbers.' };

    expect(await call('POST', '/api/pricing/bulk-runs', { scope: 'all' }, 'viewer')).toEqual({ status: 403, body: refused });
    expect(await call('POST', '/api/pricing/bulk-runs', { scope: 'all' }, '')).toEqual({ status: 401, body: { error: 'Sign in required' } });
    expect(await call('POST', '/api/pricing/bulk-runs/1/stop', undefined, 'viewer')).toEqual({ status: 403, body: refused });
    expect(db.state.runs).toEqual([]);
    // Viewers can still see everything.
    expect((await call('GET', '/api/pricing/bulk-runs', undefined, 'viewer')).status).toBe(200);

    const res = await call('POST', '/api/pricing/bulk-runs', { scope: 'all' }, 'admin');
    expect(res.status).toBe(202);
    await waitForRun(res.body.runId);
  });

  it('refuses a request it cannot run', async () => {
    expect(await call('POST', '/api/pricing/bulk-runs', { scope: 'everything' }))
      .toEqual({ status: 400, body: { error: 'scope must be one of: due, missing, all, selected.' } });
    expect(await call('POST', '/api/pricing/bulk-runs', { scope: 'selected', serialNumbers: [] }))
      .toEqual({ status: 400, body: { error: 'Choose at least one item: serialNumbers must be a list of stock codes.' } });
    expect(await call('POST', '/api/pricing/bulk-runs', { scope: 'selected', serialNumbers: ['CAP-001', ' '] }))
      .toEqual({ status: 400, body: { error: 'Choose at least one item: serialNumbers must be a list of stock codes.' } });
    expect(await call('POST', '/api/pricing/bulk-runs', { scope: 'all', dryRun: 'yes' }))
      .toEqual({ status: 400, body: { error: 'dryRun must be true or false.' } });
    expect(db.state.runs).toEqual([]);
  });

  it('starts the run, answers straight away, and the run finishes in the background', async () => {
    addItem('CAP-001', 'CL10B104KB8NNNC', '0.5');
    addItem('CON-002', 'HX20007-5AWB');
    quotes['HX20007-5AWB'] = { mouser: { error: 'No match found' } };

    const res = await call('POST', '/api/pricing/bulk-runs', { scope: 'all' }, 'manager');

    expect(res).toEqual({ status: 202, body: { runId: 1 } });
    const detail = await waitForRun(1);
    expect(detail.run).toMatchObject({
      id: 1, trigger: 'manual', scope: 'all', dryRun: false, qty: 1000, status: 'completed', requestedBy: 'manager@example.com',
      total: 2, checked: 2, updated: 1, noPrice: 1, failed: 0, stale: false,
    });
    expect(detail.reasons).toEqual([{ status: 'no_price', reason: 'No price found', count: 1 }]);
    expect(detail.items).toEqual([
      expect.objectContaining({ serialNumber: 'CAP-001', name: 'CAP-001 name', status: 'updated', oldPriceZar: 0.5, newPriceZar: 1.65, newPriceUsd: 0.1, provider: 'mouser', source: 'manual' }),
      expect.objectContaining({ serialNumber: 'CON-002', status: 'no_price', reason: 'No price found (mouser: No match found)', newPriceZar: null }),
    ]);
    expect(db.state.inventory.get('CAP-001')).toMatchObject({ bulk_price_zar: '1.65', bulk_price_usd: '0.1', stock: 7 });
    expect(notified).toBe(1);
  });

  it('prices only the chosen items, each once', async () => {
    addItem('A', 'PN-A');
    addItem('B', 'PN-B');
    addItem('C', 'PN-C');

    const res = await call('POST', '/api/pricing/bulk-runs', { scope: 'selected', serialNumbers: [' B', 'C', 'B'] });
    await waitForRun(res.body.runId);

    expect(quoteCalls.sort()).toEqual(['PN-B', 'PN-C']);
  });

  it('runs a preview without changing any price', async () => {
    addItem('A', 'PN-A', '5');

    const res = await call('POST', '/api/pricing/bulk-runs', { scope: 'all', dryRun: true });
    const detail = await waitForRun(res.body.runId);

    expect(detail.run).toMatchObject({ dryRun: true, updated: 1, note: 'Preview only: nothing was written.' });
    expect(detail.items[0]).toMatchObject({ status: 'updated', oldPriceZar: 5, newPriceZar: 1.65, dryRun: true });
    expect(db.state.inventory.get('A')).toMatchObject({ bulk_price_zar: '5' });
    expect(notified).toBe(0);
  });

  it('refuses a second run while one is in progress, and stops the first on request', async () => {
    addItem('A', 'PN-A');
    addItem('B', 'PN-B');
    holdQuotes();

    const first = await call('POST', '/api/pricing/bulk-runs', { scope: 'all' });
    const second = await call('POST', '/api/pricing/bulk-runs', { scope: 'due' });
    expect(first.status).toBe(202);
    expect(second).toEqual({ status: 409, body: { error: 'A bulk pricing run is already in progress (run #1).', runId: 1 } });

    const running = await call('GET', '/api/pricing/bulk-runs/1');
    expect(running.body.run).toMatchObject({ status: 'running', total: 2, checked: 0 });

    expect(await call('POST', '/api/pricing/bulk-runs/1/stop'))
      .toEqual({ status: 200, body: { ok: true, message: 'The run will stop after the item it is pricing now.' } });
    releaseHold();
    const detail = await waitForRun(1);

    expect(detail.run).toMatchObject({ status: 'stopped', checked: 1, total: 2, stopRequested: true, note: 'Stopped on request after 1 of 2 items.' });
    expect(quoteCalls).toEqual(['PN-A']);
    expect(await call('POST', '/api/pricing/bulk-runs/1/stop')).toEqual({ status: 409, body: { error: 'That run is not in progress.' } });
    // The slot is free again.
    const third = await call('POST', '/api/pricing/bulk-runs', { scope: 'due' });
    expect(third).toEqual({ status: 202, body: { runId: 2 } });
    await waitForRun(2);
  });
});

describe('GET /api/pricing/bulk-runs', () => {
  it('lists runs newest first, flagging one whose server went quiet', async () => {
    const now = db.state.now;
    db.state.runs.push(
      { id: 1, trigger: 'auto', scope: 'due', dry_run: false, qty: 1000, status: 'completed', started_at: now - 2 * DAY, heartbeat_at: now - 2 * DAY, finished_at: now - 2 * DAY, total: 3, checked: 3, updated: 2, unchanged: 1 },
      { id: 2, trigger: 'manual', scope: 'all', dry_run: false, qty: 1000, status: 'running', started_at: now - 3_600_000, heartbeat_at: now - 30 * 60_000, total: 9, checked: 4 },
    );

    const res = await call('GET', '/api/pricing/bulk-runs?limit=5');

    expect(res.status).toBe(200);
    expect(res.body.runs.map((r: any) => [r.id, r.status, r.stale])).toEqual([[2, 'running', true], [1, 'completed', false]]);
    expect(res.body.runs[1]).toMatchObject({ trigger: 'auto', updated: 2, unchanged: 1, startedAt: new Date(now - 2 * DAY).toISOString() });
  });

  it('answers 400 for a bad id and 404 for a missing run', async () => {
    expect((await call('GET', '/api/pricing/bulk-runs/abc')).status).toBe(400);
    expect(await call('GET', '/api/pricing/bulk-runs/99')).toEqual({ status: 404, body: { error: 'Run not found.' } });
    expect((await call('POST', '/api/pricing/bulk-runs/0/stop')).status).toBe(400);
  });
});

describe('GET /api/pricing/bulk-status', () => {
  const now = Date.now();
  // Rows as the status-list SQL returns them (`due` is computed there).
  const statusRow = (over: Record<string, unknown>) => ({
    serial_number: 'X', name: null, part_number: 'PN', bulk_price_zar: null, bulk_price_usd: null,
    last_attempt_at: null, last_success_at: null, last_run_id: null, last_source: null, last_status: null,
    last_old_price_zar: null, last_new_price_zar: null, last_error: null, due: false, total_count: '3', ...over,
  });

  beforeEach(() => {
    db.state.canned.push(
      { test: /COUNT\(\*\) OVER \(\)/, rows: [
        statusRow({ serial_number: 'CAP-001', name: '100nF', part_number: 'CL10B104KB8NNNC', lcsc_code: 'C1591', bulk_price_zar: '0.0693', bulk_price_usd: '0.0042',
          last_attempt_at: new Date(now - 40 * DAY), last_success_at: new Date(now - 40 * DAY), last_run_id: 3, last_source: 'auto', last_status: 'updated',
          last_old_price_zar: '0.0700', last_new_price_zar: '0.0693', due: true }),
        statusRow({ serial_number: 'CON-002', part_number: 'HX20007-5AWB', bulk_price_zar: '1.65',
          last_attempt_at: new Date(now - 2 * DAY), last_success_at: new Date(now - 10 * DAY), last_run_id: 4, last_source: 'manual', last_status: 'no_price',
          last_error: 'No price found (mouser: No match found)' }),
        statusRow({ serial_number: 'MISC-001', part_number: null, bulk_price_zar: '' }),
      ] },
      { test: /COUNT\(\*\) AS all_items/, rows: [{ all_items: '1520', due: '1400', problems: '12', never: '1300', missing: '52', no_part_number: '80' }] },
    );
  });

  it('gives each item its last result and when it is next due', async () => {
    db.state.runs.push(
      { id: 3, trigger: 'auto', scope: 'due', status: 'completed', started_at: now - DAY, heartbeat_at: now - DAY },
      { id: 4, trigger: 'manual', scope: 'all', status: 'running', started_at: now - 60_000, heartbeat_at: now },
    );

    const res = await call('GET', '/api/pricing/bulk-status');

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      expect.objectContaining({ serialNumber: 'CAP-001', name: '100nF', partNumber: 'CL10B104KB8NNNC', lcscCode: 'C1591', bulkPriceZar: 0.0693, bulkPriceUsd: 0.0042,
        lastSuccessAt: new Date(now - 40 * DAY).toISOString(), lastStatus: 'updated', lastSource: 'auto', lastRunId: 3,
        lastOldPriceZar: 0.07, lastNewPriceZar: 0.0693, due: true, nextDueAt: null }),
      // Priced 10 days ago, last attempt failed 2 days ago: due when 35 days have passed.
      expect.objectContaining({ serialNumber: 'CON-002', lastStatus: 'no_price', lastError: 'No price found (mouser: No match found)',
        due: false, nextDueAt: new Date(now + 25 * DAY).toISOString() }),
      expect.objectContaining({ serialNumber: 'MISC-001', partNumber: null, bulkPriceZar: null, due: false, nextDueAt: null, lastSuccessAt: null }),
    ]);
    expect(res.body).toMatchObject({
      total: 3, limit: 100, offset: 0,
      counts: { all: 1520, due: 1400, problems: 12, never: 1300, missing: 52, noPartNumber: 80 },
      settings: DEFAULT_SETTINGS,
      warnings: [],
      running: { id: 4, status: 'running' },
      lastAutoRun: { id: 3, trigger: 'auto', status: 'completed' },
    });
    expect(res.body.nextAutoRunAt).toMatch(/T02:30:00\.000Z$/);
    const next = Date.parse(res.body.nextAutoRunAt);
    expect(next).toBeGreaterThan(now);
    expect(next - now).toBeLessThanOrEqual(DAY);
  });

  it('filters, sorts, searches and pages in SQL, with the due rule’s settings', async () => {
    await call('GET', '/api/pricing/bulk-status?filter=due&sort=failed&search=50%25_off%5C&limit=9999&offset=40');

    const i = db.state.statements.findIndex((s) => /COUNT\(\*\) OVER \(\)/.test(s));
    const sql = db.state.statements[i];
    expect(sql).toContain(`SELECT s.*, (${norm(STATUS_FILTERS.due)}) AS due,`);
    expect(sql).toContain(`WHERE ${norm(STATUS_FILTERS.due)} AND (s.serial_number ILIKE $3 OR s.name ILIKE $3 OR s.part_number ILIKE $3 OR s.lcsc_code ILIKE $3)`);
    expect(sql).toContain(`ORDER BY ${norm(STATUS_SORTS.failed)} LIMIT $4 OFFSET $5`);
    expect(db.state.params[i]).toEqual([35, 7, '%50\\%\\_off\\\\%', 500, 40]);
  });

  it('refuses an unknown filter or sort', async () => {
    expect(await call('GET', '/api/pricing/bulk-status?filter=late'))
      .toEqual({ status: 400, body: { error: 'filter must be one of: all, due, problems, never, missing, no_part_number.' } });
    expect(await call('GET', '/api/pricing/bulk-status?sort=price'))
      .toEqual({ status: 400, body: { error: 'sort must be one of: oldest, recent, failed, code.' } });
  });

  it('shows no next automatic run when automatic runs are off', async () => {
    db.state.settings.set('bulkPricing', JSON.stringify({ ...DEFAULT_SETTINGS, autoEnabled: false }));

    const res = await call('GET', '/api/pricing/bulk-status');

    expect(res.body).toMatchObject({ nextAutoRunAt: null, running: null, lastAutoRun: null });
  });
});

describe('GET /api/pricing/bulk-status/:serial/history', () => {
  it('returns the item’s real changes, newest first, without previews', async () => {
    const now = db.state.now;
    db.state.history.push(
      { id: 1, run_id: 1, serial_number: 'A', source: 'auto', dry_run: false, status: 'updated', old_price_zar: '1.0000', new_price_zar: '1.2000', created_at: now - 36 * DAY },
      { id: 2, run_id: 2, serial_number: 'A', source: 'manual', dry_run: true, status: 'updated', old_price_zar: '1.2000', new_price_zar: '1.3000', created_at: now - 2 * DAY },
      { id: 3, run_id: 3, serial_number: 'A', source: 'auto', dry_run: false, status: 'unchanged', old_price_zar: '1.2000', new_price_zar: '1.2000', created_at: now - DAY },
      { id: 4, run_id: 3, serial_number: 'B', source: 'auto', dry_run: false, status: 'updated', created_at: now - DAY },
    );

    const res = await call('GET', '/api/pricing/bulk-status/A/history');

    expect(res.status).toBe(200);
    expect(res.body.retentionDays).toBe(40);
    expect(res.body.history.map((h: any) => [h.id, h.status, h.oldPriceZar, h.newPriceZar])).toEqual([[3, 'unchanged', 1.2, 1.2], [1, 'updated', 1, 1.2]]);
  });
});

describe('bulk pricing settings', () => {
  it('shows the settings, the defaults and any warning', async () => {
    db.state.settings.set('bulkPricing', JSON.stringify({ ...DEFAULT_SETTINGS, historyRetentionDays: 30 }));

    const res = await call('GET', '/api/pricing/bulk-settings');

    expect(res.status).toBe(200);
    expect(res.body.settings).toMatchObject({ historyRetentionDays: 30, autoThresholdDays: 35 });
    expect(res.body.defaults).toEqual(DEFAULT_SETTINGS);
    expect(res.body.warnings).toHaveLength(1);
  });

  it('lets only an admin change them', async () => {
    expect(await call('PUT', '/api/pricing/bulk-settings', { autoThresholdDays: 40 }, 'user'))
      .toEqual({ status: 403, body: { error: 'Admin access required' } });
    expect(await call('PUT', '/api/pricing/bulk-settings', { autoThresholdDays: 40 }, ''))
      .toEqual({ status: 401, body: { error: 'Sign in required' } });
    expect(db.state.settings.size).toBe(0);
  });

  it('saves a change over the current settings, and warns when history would not cover a cycle', async () => {
    db.state.settings.set('bulkPricing', JSON.stringify({ ...DEFAULT_SETTINGS, autoBatchSize: 50 }));

    const res = await call('PUT', '/api/pricing/bulk-settings', { historyRetentionDays: 30, autoThresholdDays: 45 }, 'admin');

    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual({ ...DEFAULT_SETTINGS, autoBatchSize: 50, historyRetentionDays: 30, autoThresholdDays: 45 });
    expect(res.body.warnings[0]).toContain('kept for 30 days but items are re-priced after 45');
    expect(JSON.parse(db.state.settings.get('bulkPricing')!)).toEqual(res.body.settings);
  });

  it('refuses a bad value and keeps what was there', async () => {
    const res = await call('PUT', '/api/pricing/bulk-settings', { historyRetentionDays: 7 }, 'admin');

    expect(res).toEqual({ status: 400, body: { error: 'Keep history for (days) must be a whole number from 30 to 3650.' } });
    expect(db.state.settings.size).toBe(0);
  });
});
