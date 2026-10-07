// @vitest-environment node
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The bulk pricing problem review: the real routes on a real Express app,
// against the in-memory database stand-in (./bulkPricingFakeDb), with
// scripted supplier quotes.

vi.mock('./db', () => ({
  pool: { connect: async () => { throw new Error('the real pool must not be used in tests'); } },
  query: async () => { throw new Error('the real query must not be used in tests'); },
  queryOne: async () => null,
  exec: async () => {},
}));

import { registerBulkPricingReviewRoutes } from './bulkPricingReview';
import { DEFAULT_SETTINGS, priceOrNull, summariseQuote, type EngineDeps } from './bulkPricing';
import { pickPartNumbers, PART_NUMBER_FIELDS } from './partNumbers';
import { fakeDb, type FakeDb } from './bulkPricingFakeDb';

const FX = { usdToZar: 16.5, ratesToZar: { USD: 16.5, ZAR: 1 } };

let db: FakeDb;
let quotes: Record<string, any>;
let quoteCalls: Array<[string, string | null]>;
let fx: typeof FX | { usdToZar: null; ratesToZar: Record<string, number> };
let notices: string[][];

const deps: EngineDeps = {
  readSettings: async () => ({ ...DEFAULT_SETTINGS }),
  readFx: async () => fx as any,
  selectItems: async (_scope, options) => [...db.state.inventory.entries()]
    .filter(([sn]) => (options.serialNumbers ?? []).includes(sn))
    .map(([sn, r]) => {
      const { partNumber, lcscCode } = pickPartNumbers(PART_NUMBER_FIELDS.map((f) => r[f]));
      return { serialNumber: sn, name: r.name ?? null, partNumber, lcscCode, bulkPriceZar: priceOrNull(r.bulk_price_zar), bulkPriceUsd: priceOrNull(r.bulk_price_usd) };
    }),
  quote: async (partNumber, _qty, _maxAge, lcscCode) => {
    quoteCalls.push([partNumber, lcscCode]);
    const q = quotes[partNumber];
    if (q instanceof Error) throw q;
    return { partNumber, qty: 1000, codeFormat: 'mfn', ...(q ?? {}) };
  },
  connect: async () => ({ query: (t: string, p?: any[]) => db.run(t, p), release: () => {} }) as any,
  query: (t, p) => db.run(t, p),
  sleep: async () => {},
  notifyChanged: async (keys) => { notices.push(keys); },
};

let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', (req: any, _res, next) => {
    const role = req.headers['x-test-role'];
    if (role) req.user = { id: 1, email: `${role}@example.com`, role: String(role) };
    next();
  });
  registerBulkPricingReviewRoutes(app, deps);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));

const MOUSER_241 = { mouser: { unitPrice: 241, currency: 'USD', partNumber: 'PASTERNACK-RF' }, lcsc: { unitPrice: 0.0064, currency: 'USD', partNumber: 'C1591' } };

beforeEach(() => {
  db = fakeDb(Date.now());
  quotes = {};
  quoteCalls = [];
  fx = FX;
  notices = [];
  const now = db.state.now;
  // A capacitor whose cheapest answer was a wrong match, held back by the last run.
  db.state.inventory.set('CAP-009', { name: '100nF', man_pn_1: 'CL10B104KB8NNNC', sup_pn_3: 'C1591', bulk_price_zar: '0.5', bulk_price_usd: '0.0303' });
  db.state.status.set('CAP-009', { last_status: 'flagged', last_error: 'Cheapest price, 241 USD from mouser…', last_attempt_at: now - 60_000, last_success_at: null });
  db.state.history.push({ id: 1, run_id: 5, serial_number: 'CAP-009', part_number: 'CL10B104KB8NNNC', source: 'manual', dry_run: false, status: 'flagged',
    provider: 'mouser', matched_part: 'PASTERNACK-RF', new_price_zar: 3976.5, new_price_usd: 241, error: 'Cheapest price, 241 USD from mouser…',
    offers: summariseQuote({ partNumber: 'CL10B104KB8NNNC', qty: 1000, codeFormat: 'mfn', ...MOUSER_241 } as any, FX), created_at: now - 60_000 });
  db.state.nextHistoryId = 2;
  // A connector no supplier knows, from an older run (no answers kept).
  db.state.inventory.set('CON-025', { name: 'Connector', man_pn_1: '15M1810', bulk_price_zar: '12', bulk_price_usd: '0.7273' });
  db.state.status.set('CON-025', { last_status: 'no_price', last_error: 'No price found (mouser: No match found)', last_attempt_at: now - 3_600_000 });
  // A healthy item: not a problem.
  db.state.inventory.set('RES-005', { name: '10k', man_pn_1: 'RC0603FR-0710KL', bulk_price_zar: '0.02', bulk_price_usd: '0.0012' });
  db.state.status.set('RES-005', { last_status: 'updated', last_success_at: now });
});

const call = async (method: string, path: string, body?: unknown, role = 'engineer') => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(role ? { 'x-test-role': role } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const refused = { status: 403, body: { error: 'Only admins, managers and engineers can change inventory, prices and part numbers.' } };

describe('GET /api/pricing/bulk-review', () => {
  it("lists the problem items, held back first, each with its latest result and every supplier's answer", async () => {
    const res = await call('GET', '/api/pricing/bulk-review', undefined, 'viewer');

    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ all: 2, flagged: 1, no_price: 1, failed: 0 });
    expect(res.body.entries.map((e: any) => [e.serialNumber, e.problem])).toEqual([['CAP-009', 'flagged'], ['CON-025', 'no_price']]);
    expect(res.body.entries[0]).toMatchObject({
      partNumber: 'CL10B104KB8NNNC', lcscCode: 'C1591', bulkPriceZar: 0.5,
      result: { historyId: 1, status: 'flagged', runId: 5, recheck: false, provider: 'mouser', proposedZar: 3976.5,
        answers: [expect.objectContaining({ provider: 'mouser', zar: 3976.5 }), expect.objectContaining({ provider: 'lcsc', zar: 0.1056 })] },
    });
    expect(res.body.entries[1].result).toBeNull();
  });

  it('narrows to one kind of problem', async () => {
    expect((await call('GET', '/api/pricing/bulk-review?kind=no_price')).body.entries.map((e: any) => e.serialNumber)).toEqual(['CON-025']);
    expect((await call('GET', '/api/pricing/bulk-review?kind=late')).status).toBe(400);
  });
});

describe('approving a price', () => {
  it("writes the chosen supplier's price from the latest result, records who approved it, and takes the item off the list", async () => {
    const res = await call('POST', '/api/pricing/bulk-review/CAP-009/approve', { historyId: 1, provider: 'lcsc' }, 'manager');

    expect(res).toMatchObject({ status: 200, body: { decision: 'approved', changed: true, oldPriceZar: 0.5, newPriceZar: 0.1056, newPriceUsd: 0.0064 } });
    expect(db.state.inventory.get('CAP-009')).toMatchObject({ bulk_price_zar: '0.1056', bulk_price_usd: '0.0064', man_pn_1: 'CL10B104KB8NNNC' });
    expect(db.state.history.at(-1)).toMatchObject({ status: 'approved', source: 'manual', dry_run: false, run_id: null, provider: 'lcsc', matched_part: 'C1591',
      old_price_zar: 0.5, new_price_zar: 0.1056, decided_by: 'manager@example.com', error: "Approved lcsc's price for C1591." });
    expect(db.state.status.get('CAP-009')).toMatchObject({ last_status: 'approved', last_success_at: db.state.now, last_new_price_zar: 0.1056 });
    expect(notices.at(-1)).toEqual(['bulk_pricing', 'inventory']);
    expect((await call('GET', '/api/pricing/bulk-review')).body.counts).toMatchObject({ all: 1, flagged: 0 });
  });

  it('can approve the held-back price itself', async () => {
    await call('POST', '/api/pricing/bulk-review/CAP-009/approve', { historyId: 1, provider: 'mouser' });

    expect(db.state.inventory.get('CAP-009')).toMatchObject({ bulk_price_zar: '3976.5', bulk_price_usd: '241' });
  });

  it('refuses a stale result, a supplier without a price, and a viewer', async () => {
    expect(await call('POST', '/api/pricing/bulk-review/CAP-009/approve', { historyId: 99, provider: 'lcsc' }))
      .toEqual({ status: 409, body: { error: 'There is a newer result for this item. Reload it and check again.' } });
    expect(await call('POST', '/api/pricing/bulk-review/CAP-009/approve', { historyId: 1, provider: 'tme' }))
      .toEqual({ status: 400, body: { error: 'That supplier has no usable price in this result.' } });
    expect(await call('POST', '/api/pricing/bulk-review/CAP-009/approve', { historyId: 1, provider: 'lcsc' }, 'viewer')).toEqual(refused);
    expect((await call('POST', '/api/pricing/bulk-review/CAP-009/approve', { provider: 'lcsc' })).status).toBe(400);
    expect(await call('POST', '/api/pricing/bulk-review/NOPE-1/approve', { historyId: 1, provider: 'lcsc' })).toEqual({ status: 404, body: { error: 'Item not found.' } });
    expect(db.state.inventory.get('CAP-009')!.bulk_price_zar).toBe('0.5');
  });
});

describe('keeping the current price, and setting one by hand', () => {
  it('keeps the price, with the reason, and takes the item off the list', async () => {
    const res = await call('POST', '/api/pricing/bulk-review/CAP-009/reject', { note: 'Mouser matched an RF part' });

    expect(res.body).toMatchObject({ decision: 'rejected', changed: false, newPriceZar: 0.5 });
    expect(db.state.inventory.get('CAP-009')!.bulk_price_zar).toBe('0.5');
    expect(db.state.history.at(-1)).toMatchObject({ status: 'rejected', error: 'Kept the current price: Mouser matched an RF part', decided_by: 'engineer@example.com' });
    expect(db.state.status.get('CAP-009')).toMatchObject({ last_status: 'rejected', last_success_at: db.state.now });
    expect(notices.at(-1)).toEqual(['bulk_pricing']);
  });

  it('sets a price in rand, working out the dollars at the stored rate', async () => {
    const res = await call('POST', '/api/pricing/bulk-review/CON-025/price', { zar: 9.9 });

    expect(res.body).toMatchObject({ decision: 'manual', changed: true, oldPriceZar: 12, newPriceZar: 9.9, newPriceUsd: 0.6 });
    expect(db.state.inventory.get('CON-025')).toMatchObject({ bulk_price_zar: '9.9', bulk_price_usd: '0.6' });
    expect(db.state.history.at(-1)).toMatchObject({ status: 'manual', provider: 'manual', error: 'Set by hand.' });
  });

  it('refuses a price that is not a positive number, or without an exchange rate', async () => {
    expect((await call('POST', '/api/pricing/bulk-review/CON-025/price', { zar: 0 })).body).toEqual({ error: 'The price must be a number of rand above 0.' });
    expect((await call('POST', '/api/pricing/bulk-review/CON-025/price', { zar: 'cheap' })).status).toBe(400);
    fx = { usdToZar: null, ratesToZar: {} };
    expect((await call('POST', '/api/pricing/bulk-review/CON-025/price', { zar: 9.9 })).body).toEqual({ error: 'No USD to ZAR exchange rate is stored. Refresh the exchange rate first.' });
    expect(db.state.inventory.get('CON-025')!.bulk_price_zar).toBe('12');
  });
});

describe('re-checking', () => {
  it("asks the suppliers again (LCSC by the item's LCSC number) and shows their answers without changing the price", async () => {
    quotes['CL10B104KB8NNNC'] = { mouser: { unitPrice: 0.01, currency: 'USD', partNumber: 'CL10B104KB8NNNC' }, lcsc: { unitPrice: 0.0064, currency: 'USD', partNumber: 'C1591' } };

    const res = await call('POST', '/api/pricing/bulk-review/CAP-009/recheck');

    expect(quoteCalls).toEqual([['CL10B104KB8NNNC', 'C1591']]);
    expect(res.body.entry).toMatchObject({ serialNumber: 'CAP-009', problem: 'flagged',
      result: { status: 'offer', recheck: true, decidedBy: 'engineer@example.com', provider: 'lcsc', proposedZar: 0.1056,
        answers: [expect.objectContaining({ provider: 'mouser', zar: 0.165 }), expect.objectContaining({ provider: 'lcsc', zar: 0.1056 })] } });
    expect(db.state.inventory.get('CAP-009')!.bulk_price_zar).toBe('0.5');
    expect(db.state.status.get('CAP-009')!.last_status).toBe('flagged');

    // The re-check is now the latest result, so it is what can be approved.
    const approved = await call('POST', '/api/pricing/bulk-review/CAP-009/approve', { historyId: res.body.entry.result.historyId, provider: 'mouser' });
    expect(approved.body).toMatchObject({ newPriceZar: 0.165 });
  });

  it('records a failed lookup, and refuses an item without a part number', async () => {
    quotes['15M1810'] = new Error('fetch failed');
    const res = await call('POST', '/api/pricing/bulk-review/CON-025/recheck');
    expect(res.body.entry.result).toMatchObject({ status: 'failed', reason: 'Supplier lookup failed: fetch failed', answers: null });

    db.state.inventory.set('ASS-001', { name: 'Assembly', man_pn_1: 'N/A' });
    expect(await call('POST', '/api/pricing/bulk-review/ASS-001/recheck')).toEqual({ status: 400, body: { error: 'The item has no part number to look up. Add one first.' } });
    expect(await call('POST', '/api/pricing/bulk-review/CAP-009/recheck', undefined, 'viewer')).toEqual(refused);
  });
});

describe('excluding an item', () => {
  it('takes it off the problem list, and putting it back returns it', async () => {
    const res = await call('POST', '/api/pricing/bulk-review/CON-025/exclude', { excluded: true }, 'admin');

    expect(res.body).toEqual({ serialNumber: 'CON-025', excluded: true });
    expect(db.state.status.get('CON-025')).toMatchObject({ excluded: true, excluded_by: 'admin@example.com', last_status: 'no_price' });
    expect(db.state.history.at(-1)).toMatchObject({ status: 'excluded', error: 'Left out of bulk pricing.', old_price_zar: 12, new_price_zar: 12 });
    expect((await call('GET', '/api/pricing/bulk-review')).body.counts).toEqual({ all: 1, flagged: 1, no_price: 0, failed: 0 });

    await call('POST', '/api/pricing/bulk-review/CON-025/exclude', { excluded: false });
    expect((await call('GET', '/api/pricing/bulk-review')).body.counts.no_price).toBe(1);
    expect(db.state.history.at(-1)).toMatchObject({ status: 'included', decided_by: 'engineer@example.com' });
  });

  it('can exclude an item that has never been priced', async () => {
    db.state.inventory.set('PCB-001', { name: 'TCU PCB', man_pn_1: 'TCU04' });

    expect((await call('POST', '/api/pricing/bulk-review/PCB-001/exclude', { excluded: true })).status).toBe(200);
    expect(db.state.status.get('PCB-001')).toMatchObject({ excluded: true });
    expect((await call('POST', '/api/pricing/bulk-review/PCB-001/exclude', { excluded: 'yes' })).status).toBe(400);
    expect(await call('POST', '/api/pricing/bulk-review/PCB-001/exclude', { excluded: false }, 'viewer')).toEqual(refused);
  });
});
