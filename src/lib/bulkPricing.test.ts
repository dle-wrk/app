// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The engine is driven through its injectable dependencies: an in-memory
// stand-in for the database (./bulkPricingFakeDb: BEGIN/COMMIT/ROLLBACK as
// snapshots, the one-running-run unique index; any other SQL fails the test),
// a scripted supplier quote, a fixed clock and a no-op sleep.

vi.mock('./db', () => ({
  pool: { connect: async () => { throw new Error('the real pool must not be used in tests'); } },
  query: async () => { throw new Error('the real query must not be used in tests'); },
  queryOne: async () => null,
  exec: async () => {},
}));

import {
  DEFAULT_SETTINGS, RunInProgressError, beginRun, chooseOffer, groupReasons, isDue, nextAutoRunAt, nextDueAt, parseSettings,
  processRun, purgeHistory, requestStop, runAutoBulkPricing, runBulkPricing,
  type BulkPricingSettings, type EngineDeps, type PricingItem, type RunScope, type SelectOptions,
} from './bulkPricing';
import { DAY, NOW, fakeDb } from './bulkPricingFakeDb';

const FX = { usdToZar: 16.5, ratesToZar: { USD: 16.5, ZAR: 1, EUR: 18, GBP: 21 } };

let db: ReturnType<typeof fakeDb>;
let quotes: Record<string, any>;
let quoteCalls: string[];
let sleeps: number[];
let notified: number;
let settings: BulkPricingSettings;
let fx: typeof FX | { usdToZar: null; ratesToZar: Record<string, number> };
let items: Record<string, { partNumber: string | null; name?: string }>;

const usd = (unitPrice: number, partNumber = 'MATCHED') => ({ unitPrice, currency: 'USD', partNumber });
const quote = (prices: Record<string, any>) => ({ partNumber: 'X', qty: 1000, codeFormat: 'mfn', ...prices });

// The same selection rules as the SQL, over the stand-in's rows.
async function selectFake(scope: RunScope, options: SelectOptions): Promise<PricingItem[]> {
  const now = new Date(db.state.now);
  const all = [...db.state.inventory.entries()].map(([sn, r]) => ({ sn, r, status: db.state.status.get(sn) ?? null }));
  let chosen = all.filter((x) => scope === 'selected' ? (options.serialNumbers ?? []).includes(x.sn) : items[x.sn]?.partNumber);
  if (scope === 'due') {
    chosen = chosen
      .filter((x) => isDue(x.status ? { lastAttemptAt: x.status.last_attempt_at && new Date(x.status.last_attempt_at), lastSuccessAt: x.status.last_success_at && new Date(x.status.last_success_at) } : null, now, options.settings))
      .sort((a, b) => (a.status?.last_success_at ?? -Infinity) - (b.status?.last_success_at ?? -Infinity));
  }
  if (scope === 'missing') chosen = chosen.filter((x) => !Number(x.r.bulk_price_zar));
  return chosen.slice(0, options.limit ?? 5000).map((x) => ({
    serialNumber: x.sn, name: items[x.sn]?.name ?? null, partNumber: items[x.sn]?.partNumber ?? null,
    bulkPriceZar: x.r.bulk_price_zar === null ? null : Number(x.r.bulk_price_zar),
    bulkPriceUsd: x.r.bulk_price_usd === null ? null : Number(x.r.bulk_price_usd),
  }));
}

function deps(): EngineDeps {
  return {
    readSettings: async () => settings,
    readFx: async () => fx as any,
    selectItems: selectFake,
    quote: async (partNumber) => {
      quoteCalls.push(partNumber);
      const q = quotes[partNumber];
      const value = typeof q === 'function' ? q(quoteCalls.filter((c) => c === partNumber).length) : q;
      if (value instanceof Error) throw value;
      return value ?? quote({});
    },
    connect: async () => ({ query: db.run as any, release: () => {} }),
    query: db.run as any,
    sleep: async (ms) => { sleeps.push(ms); },
    notifyChanged: async () => { notified += 1; },
  };
}

function addItem(sn: string, partNumber: string | null, zar: string | null = null, usdPrice: string | null = null) {
  items[sn] = { partNumber, name: `${sn} name` };
  db.state.inventory.set(sn, { bulk_price_zar: zar, bulk_price_usd: usdPrice, stock: 42, man_pn_1: partNumber, sup_pn_3: 'C123' });
}

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  db = fakeDb();
  quotes = {};
  quoteCalls = [];
  sleeps = [];
  notified = 0;
  settings = { ...DEFAULT_SETTINGS };
  fx = FX;
  items = {};
});

describe('chooseOffer', () => {
  it('takes the cheapest supplier, converted to rand and dollars', () => {
    const choice = chooseOffer(quote({ mouser: usd(0.1), digikey: usd(0.08), element14: { unitPrice: 0.05, currency: 'EUR' } }) as any, FX, 50);

    expect(choice).toEqual({ kind: 'offer', offer: { provider: 'element14', nativePrice: 0.05, currency: 'EUR', zar: 0.9, usd: 0.0545, matchedPart: null } });
  });

  it('does not convert a rand price a second time', () => {
    const choice = chooseOffer(quote({ mouser: { unitPrice: 2.5, currency: 'R' } }) as any, FX, 50);

    expect(choice).toMatchObject({ kind: 'offer', offer: { zar: 2.5, usd: 0.1515, currency: 'ZAR' } });
  });

  it('leaves out a price in a currency with no stored rate', () => {
    const choice = chooseOffer(quote({ tme: { unitPrice: 1, currency: 'PLN' } }) as any, FX, 50);

    expect(choice).toEqual({ kind: 'no_price', reason: 'No price found (tme: quoted in PLN, which has no stored exchange rate)', transient: false, quotaExhausted: false });
  });

  it('holds back a price above the review threshold', () => {
    const choice = chooseOffer(quote({ mouser: usd(241, 'PASTERNACK-RF') }) as any, FX, 50);

    expect(choice.kind).toBe('flagged');
    expect(choice.kind === 'flagged' && choice.reason).toContain('241 USD from mouser (matched PASTERNACK-RF), is above the 50 USD review threshold');
  });

  it('tells a supplier outage apart from a part nobody stocks', () => {
    expect(chooseOffer(quote({ mouser: { error: 'fetch failed' }, digikey: { error: 'No match found' } }) as any, FX, 50))
      .toMatchObject({ kind: 'no_price', transient: true });
    expect(chooseOffer(quote({ mouser: { error: 'No match found' } }) as any, FX, 50))
      .toMatchObject({ kind: 'no_price', transient: false, quotaExhausted: false });
  });

  it('recognises a used-up daily API quota', () => {
    expect(chooseOffer(quote({ mouser: { error: 'Daily limit reached' }, digikey: { error: 'Not configured' } }) as any, FX, 50))
      .toMatchObject({ kind: 'no_price', quotaExhausted: true });
  });
});

describe('groupReasons', () => {
  it('counts each reason once per item, without the per-part detail, most common first', () => {
    expect(groupReasons([
      { status: 'no_price', reason: 'No price found (mouser: No match found)' },
      { status: 'updated', reason: null },
      { status: 'failed', reason: 'Could not save: timeout' },
      { status: 'no_price', reason: 'No price found (digikey: No match found; tme: Not authorized)' },
    ])).toEqual([
      { status: 'no_price', reason: 'No price found', count: 2 },
      { status: 'failed', reason: 'Could not save: timeout', count: 1 },
    ]);
  });
});

describe('parseSettings', () => {
  it('fills in the defaults', () => {
    expect(parseSettings({})).toEqual({ settings: DEFAULT_SETTINGS, warnings: [] });
    expect(DEFAULT_SETTINGS).toMatchObject({ autoThresholdDays: 35, historyRetentionDays: 40 });
  });

  it('refuses history kept for less than 30 days, and other bad values', () => {
    expect(parseSettings({ historyRetentionDays: 29 })).toEqual({ error: 'Keep history for (days) must be a whole number from 30 to 3650.' });
    expect(parseSettings({ autoThresholdDays: 0 })).toEqual({ error: 'Re-price after (days) must be a whole number from 1 to 365.' });
    expect(parseSettings({ autoBatchSize: 2.5 })).toEqual({ error: 'Items per automatic run must be a whole number from 1 to 1000.' });
    expect(parseSettings({ autoEnabled: 'yes' })).toEqual({ error: 'autoEnabled must be true or false.' });
  });

  it('warns when history would be gone before an item is re-priced', () => {
    const parsed = parseSettings({ historyRetentionDays: 30, autoThresholdDays: 35 });

    expect('warnings' in parsed && parsed.warnings[0]).toContain('kept for 30 days but items are re-priced after 35');
  });
});

describe('isDue / nextDueAt', () => {
  const now = new Date(NOW);
  const ago = (days: number) => new Date(NOW - days * DAY);

  it('treats an item never priced as due', () => {
    expect(isDue(null, now, DEFAULT_SETTINGS)).toBe(true);
  });

  it('re-prices after 35 days, not before', () => {
    expect(isDue({ lastAttemptAt: ago(34), lastSuccessAt: ago(34) }, now, DEFAULT_SETTINGS)).toBe(false);
    expect(nextDueAt({ lastAttemptAt: ago(34), lastSuccessAt: ago(34) }, now, DEFAULT_SETTINGS)).toEqual(new Date(NOW + DAY));
    expect(isDue({ lastAttemptAt: ago(36), lastSuccessAt: ago(36) }, now, DEFAULT_SETTINGS)).toBe(true);
    expect(isDue({ lastAttemptAt: ago(36), lastSuccessAt: ago(36) }, now, { ...DEFAULT_SETTINGS, autoThresholdDays: 40 })).toBe(false);
  });

  it('waits a week before retrying an item that got no price', () => {
    expect(isDue({ lastAttemptAt: ago(3), lastSuccessAt: null }, now, DEFAULT_SETTINGS)).toBe(false);
    expect(nextDueAt({ lastAttemptAt: ago(3), lastSuccessAt: null }, now, DEFAULT_SETTINGS)).toEqual(new Date(NOW + 4 * DAY));
    expect(isDue({ lastAttemptAt: ago(8), lastSuccessAt: null }, now, DEFAULT_SETTINGS)).toBe(true);
    expect(isDue({ lastAttemptAt: ago(2), lastSuccessAt: ago(40) }, now, DEFAULT_SETTINGS)).toBe(false);
  });
});

describe('a manual run', () => {
  it('writes the bulk price, records it, and touches nothing else on the item', async () => {
    addItem('CON-002', 'HX20007-5AWB', '1.387', null);
    addItem('CAP-009', 'CL10B104KB8NNNC', null, null);
    quotes['HX20007-5AWB'] = quote({ mouser: usd(0.1), digikey: usd(0.12) });
    quotes['CL10B104KB8NNNC'] = quote({ lcsc: { unitPrice: 0.0042, currency: 'USD', partNumber: 'C1591' } });

    const summary = await runBulkPricing({ trigger: 'manual', scope: 'all', requestedBy: 'dylan@example.com' }, deps());

    expect(summary).toMatchObject({ status: 'completed', total: 2, checked: 2, updated: 2, unchanged: 0, failed: 0, reasons: [] });
    expect(db.state.inventory.get('CON-002')).toEqual({ bulk_price_zar: '1.65', bulk_price_usd: '0.1', stock: 42, man_pn_1: 'HX20007-5AWB', sup_pn_3: 'C123' });
    expect(db.state.inventory.get('CAP-009')).toMatchObject({ bulk_price_zar: '0.0693', bulk_price_usd: '0.0042' });
    expect(db.state.statements.filter((s) => s.startsWith('UPDATE inventory'))).toEqual([
      'UPDATE inventory SET bulk_price_zar = $1, bulk_price_usd = $2 WHERE serial_number = $3',
      'UPDATE inventory SET bulk_price_zar = $1, bulk_price_usd = $2 WHERE serial_number = $3',
    ]);
    expect(db.state.history.find((h) => h.serial_number === 'CON-002')).toMatchObject({
      run_id: 1, source: 'manual', dry_run: false, status: 'updated', old_price_zar: 1.387, new_price_zar: 1.65,
      old_price_usd: null, new_price_usd: 0.1, provider: 'mouser', native_price: 0.1, native_currency: 'USD', qty: 1000,
    });
    expect(db.state.status.get('CON-002')).toMatchObject({ last_status: 'updated', last_success_at: NOW, last_attempt_at: NOW, last_old_price_zar: 1.387, last_new_price_zar: 1.65, last_run_id: 1 });
    expect(db.state.runs[0]).toMatchObject({ status: 'completed', trigger: 'manual', requested_by: 'dylan@example.com', total: 2, checked: 2, updated: 2 });
    // Open tabs are told once, at the end, to reload the inventory.
    expect(notified).toBe(1);
  });

  it('writes nothing the second time when prices have not moved', async () => {
    addItem('CON-002', 'HX20007-5AWB');
    quotes['HX20007-5AWB'] = quote({ mouser: usd(0.1) });
    await runBulkPricing({ trigger: 'manual', scope: 'all' }, deps());
    db.state.statements = [];
    db.state.now += DAY;

    const again = await runBulkPricing({ trigger: 'manual', scope: 'all' }, deps());

    expect(again).toMatchObject({ updated: 0, unchanged: 1, status: 'completed' });
    expect(db.state.statements.some((s) => s.startsWith('UPDATE inventory'))).toBe(false);
    expect(db.state.status.get('CON-002')).toMatchObject({ last_status: 'unchanged', last_success_at: NOW + DAY });
    expect(notified).toBe(1); // the first run only
  });

  it('gives up on a supplier lookup that never answers, after three tries', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    addItem('A', 'PN-A', '5');
    quotes['PN-A'] = () => new Promise(() => {});

    const run = runBulkPricing({ trigger: 'manual', scope: 'all' }, deps());
    await vi.advanceTimersByTimeAsync(3 * 2 * 60_000);
    const summary = await run;

    expect(summary).toMatchObject({ status: 'completed_with_errors', failed: 1 });
    expect(summary.items[0].reason).toBe('Supplier lookup failed: the suppliers did not answer within 2 minutes');
    expect(quoteCalls).toEqual(['PN-A', 'PN-A', 'PN-A']);
    expect(db.state.inventory.get('A')).toMatchObject({ bulk_price_zar: '5' });
    // Meanwhile the run kept its heartbeat, so nothing mistook it for abandoned.
    expect(db.state.runs[0].beats).toBeGreaterThanOrEqual(5);
  });

  it('keeps going when one item fails, and says why', async () => {
    addItem('A', 'PN-A');
    addItem('B', 'PN-B');
    addItem('C', 'PN-C');
    quotes['PN-A'] = quote({ mouser: usd(0.1) });
    quotes['PN-B'] = new Error('DigiKey token expired');
    quotes['PN-C'] = quote({ mouser: usd(0.2) });

    const summary = await runBulkPricing({ trigger: 'manual', scope: 'all' }, deps());

    expect(summary).toMatchObject({ status: 'completed_with_errors', checked: 3, updated: 2, failed: 1 });
    expect(summary.reasons).toEqual([{ status: 'failed', reason: 'Supplier lookup failed: DigiKey token expired', count: 1 }]);
    expect(quoteCalls.filter((c) => c === 'PN-B')).toHaveLength(3);
    expect(db.state.status.get('B')).toMatchObject({ last_status: 'failed', last_success_at: null, last_error: 'Supplier lookup failed: DigiKey token expired' });
    expect(db.state.inventory.get('C')).toMatchObject({ bulk_price_usd: '0.2' });
  });

  it('retries a supplier outage and uses the price once it answers', async () => {
    addItem('A', 'PN-A');
    quotes['PN-A'] = (attempt: number) => attempt === 1 ? quote({ mouser: { error: 'fetch failed' } }) : quote({ mouser: usd(0.3) });

    const summary = await runBulkPricing({ trigger: 'manual', scope: 'all' }, deps());

    expect(summary).toMatchObject({ updated: 1, failed: 0 });
    expect(sleeps).toEqual([1000]);
  });

  it('retries a failed save, and a save that keeps failing changes nothing', async () => {
    addItem('A', 'PN-A', '5');
    addItem('B', 'PN-B', '7');
    quotes['PN-A'] = quote({ mouser: usd(0.1) });
    quotes['PN-B'] = quote({ mouser: usd(0.2) });
    db.state.failOn = /^INSERT INTO bulk_price_history/;
    db.state.failTimes = 1;

    const first = await runBulkPricing({ trigger: 'manual', scope: 'selected', serialNumbers: ['A'] }, deps());
    expect(first).toMatchObject({ updated: 1, failed: 0 });
    expect(db.state.inventory.get('A')).toMatchObject({ bulk_price_usd: '0.1' });

    db.state.failTimes = 99;
    const second = await runBulkPricing({ trigger: 'manual', scope: 'selected', serialNumbers: ['B'] }, deps());
    expect(second).toMatchObject({ failed: 1, updated: 0 });
    expect(second.items[0].reason).toBe('Could not save: connection reset by peer');
    // Every attempt was rolled back: the price on file is untouched.
    expect(db.state.inventory.get('B')).toMatchObject({ bulk_price_zar: '7', bulk_price_usd: null });
  });

  it('finishes cleanly when there is nothing to price', async () => {
    const summary = await runBulkPricing({ trigger: 'manual', scope: 'due' }, deps());

    expect(summary).toMatchObject({ status: 'completed', total: 0, checked: 0, note: 'Nothing was due for re-pricing.' });
    expect(db.state.runs[0]).toMatchObject({ status: 'completed', total: 0, note: 'Nothing was due for re-pricing.' });
  });

  it('previews without changing a price or an item’s status', async () => {
    addItem('A', 'PN-A', '5');
    quotes['PN-A'] = quote({ mouser: usd(0.1) });

    const summary = await runBulkPricing({ trigger: 'manual', scope: 'all', dryRun: true }, deps());

    expect(summary).toMatchObject({ updated: 1, dryRun: true, note: 'Preview only: nothing was written.' });
    expect(db.state.inventory.get('A')).toMatchObject({ bulk_price_zar: '5' });
    expect(db.state.status.size).toBe(0);
    expect(db.state.history[0]).toMatchObject({ dry_run: true, status: 'updated', new_price_zar: 1.65 });
    expect(notified).toBe(0);
  });

  it('holds back a suspicious price without writing it', async () => {
    addItem('A', 'PN-A', '5');
    quotes['PN-A'] = quote({ mouser: usd(241) });

    const summary = await runBulkPricing({ trigger: 'manual', scope: 'all' }, deps());

    expect(summary).toMatchObject({ flagged: 1, updated: 0 });
    expect(db.state.inventory.get('A')).toMatchObject({ bulk_price_zar: '5' });
    expect(db.state.status.get('A')).toMatchObject({ last_status: 'flagged', last_success_at: null });
  });

  it('skips an item with no part number, and one the API quota could not reach, leaving both due', async () => {
    addItem('NOPN', null);
    addItem('QUOTA', 'PN-Q');
    quotes['PN-Q'] = quote({ mouser: { error: 'Daily limit reached' } });

    const summary = await runBulkPricing({ trigger: 'manual', scope: 'selected', serialNumbers: ['NOPN', 'QUOTA'] }, deps());

    expect(summary).toMatchObject({ skipped: 2, failed: 0, noPrice: 0 });
    expect(summary.reasons.map((r) => r.reason)).toEqual(expect.arrayContaining([
      'No manufacturer or supplier part number to look up.',
      'Daily supplier API limit reached; it will be tried again on the next run.',
    ]));
    expect(db.state.status.size).toBe(0);
  });

  it('records a failed run when there is no exchange rate', async () => {
    fx = { usdToZar: null, ratesToZar: {} };
    addItem('A', 'PN-A');

    const summary = await runBulkPricing({ trigger: 'manual', scope: 'all' }, deps());

    expect(summary).toMatchObject({ status: 'failed', error: 'No USD to ZAR exchange rate is stored. Refresh the exchange rate, then run again.' });
    expect(quoteCalls).toEqual([]);
  });
});

describe('one run at a time', () => {
  it('refuses a second run while one is in progress', async () => {
    const first = await beginRun({ trigger: 'manual', scope: 'all' }, settings, deps());

    const second = beginRun({ trigger: 'auto', scope: 'due' }, settings, deps());

    await expect(second).rejects.toBeInstanceOf(RunInProgressError);
    await expect(second).rejects.toMatchObject({ runId: first, message: 'A bulk pricing run is already in progress (run #1).' });
    expect(db.state.runs.map((r) => r.status)).toEqual(['running']);
  });

  it('lets only one of two simultaneous requests start', async () => {
    addItem('A', 'PN-A');
    quotes['PN-A'] = quote({ mouser: usd(0.1) });

    const outcomes = await Promise.allSettled([
      runBulkPricing({ trigger: 'manual', scope: 'all' }, deps()),
      runBulkPricing({ trigger: 'manual', scope: 'all' }, deps()),
    ]);

    expect(outcomes.map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(outcomes.find((o) => o.status === 'rejected')).toMatchObject({ reason: expect.any(RunInProgressError) });
    expect(quoteCalls).toEqual(['PN-A']);
  });

  it('frees the slot once a run finishes', async () => {
    const id = await beginRun({ trigger: 'manual', scope: 'all' }, settings, deps());
    await processRun(id, { trigger: 'manual', scope: 'all' }, deps());

    await expect(beginRun({ trigger: 'manual', scope: 'all' }, settings, deps())).resolves.toBe(2);
  });

  it('stops a run on request after the item in hand', async () => {
    for (const sn of ['A', 'B', 'C']) { addItem(sn, `PN-${sn}`); quotes[`PN-${sn}`] = quote({ mouser: usd(0.1) }); }
    quotes['PN-A'] = () => { void requestStop(1, deps()); return quote({ mouser: usd(0.1) }); };

    const summary = await runBulkPricing({ trigger: 'manual', scope: 'all' }, deps());

    expect(summary).toMatchObject({ status: 'stopped', total: 3, checked: 1, updated: 1, note: 'Stopped on request after 1 of 3 items.' });
    expect(quoteCalls).toEqual(['PN-A']);
    expect(db.state.runs[0]).toMatchObject({ status: 'stopped', checked: 1 });
    expect(notified).toBe(1);
    // The slot is free again.
    await expect(beginRun({ trigger: 'manual', scope: 'all' }, settings, deps())).resolves.toBe(2);
  });

  it('has nothing to stop once a run has finished', async () => {
    await runBulkPricing({ trigger: 'manual', scope: 'all' }, deps());

    await expect(requestStop(1, deps())).resolves.toBe(false);
    expect(db.state.runs[0].stop_requested).toBe(false);
  });

  it('takes over from a run whose server stopped (no heartbeat for 10 minutes)', async () => {
    await beginRun({ trigger: 'manual', scope: 'all' }, settings, deps());
    db.state.now += 11 * 60_000;

    const id = await beginRun({ trigger: 'auto', scope: 'due' }, settings, deps());

    expect(id).toBe(2);
    expect(db.state.runs[0]).toMatchObject({ status: 'interrupted', error: 'The server stopped before this run finished.' });
  });
});

describe('the automatic run', () => {
  const status = (sn: string, successDaysAgo: number | null, attemptDaysAgo = successDaysAgo) =>
    db.state.status.set(sn, { last_attempt_at: attemptDaysAgo === null ? null : NOW - attemptDaysAgo * DAY, last_success_at: successDaysAgo === null ? null : NOW - successDaysAgo * DAY, last_status: 'updated' });

  it('re-prices items last priced over 35 days ago, and items never priced, oldest first', async () => {
    for (const sn of ['FRESH', 'OLD', 'OLDER', 'NEVER']) { addItem(sn, `PN-${sn}`); quotes[`PN-${sn}`] = quote({ mouser: usd(0.1) }); }
    status('FRESH', 34);
    status('OLD', 36);
    status('OLDER', 60);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);

    const outcome = await runAutoBulkPricing({}, deps());

    expect(outcome).toMatchObject({ ran: true, summary: { trigger: 'auto', scope: 'due', checked: 3 } });
    expect(quoteCalls).toEqual(['PN-NEVER', 'PN-OLDER', 'PN-OLD']);
    expect(db.state.runs[0]).toMatchObject({ trigger: 'auto', requested_by: 'schedule', status: 'completed' });
    expect(outcome.nextRunAt).toBe('2026-10-07T02:30:00.000Z');
  });

  it('honours a different threshold and the batch size', async () => {
    for (const sn of ['A', 'B', 'C']) { addItem(sn, `PN-${sn}`); quotes[`PN-${sn}`] = quote({ mouser: usd(0.1) }); }
    status('A', 50);
    status('B', 45);
    status('C', 41);
    settings = { ...settings, autoThresholdDays: 42, autoBatchSize: 1 };

    await runAutoBulkPricing({}, deps());

    expect(quoteCalls).toEqual(['PN-A']);
  });

  it('logs a run even when nothing is due', async () => {
    addItem('FRESH', 'PN-FRESH');
    status('FRESH', 1);

    const outcome = await runAutoBulkPricing({}, deps());

    expect(outcome.summary).toMatchObject({ checked: 0, note: 'Nothing was due for re-pricing.' });
    expect(db.state.runs).toHaveLength(1);
  });

  it('does nothing but clean up when switched off', async () => {
    settings = { ...settings, autoEnabled: false };
    addItem('NEVER', 'PN-NEVER');

    const outcome = await runAutoBulkPricing({}, deps());

    expect(outcome).toMatchObject({ ran: false, reason: 'Automatic bulk pricing is turned off.' });
    expect(db.state.runs).toEqual([]);
  });

  it('steps aside when a run is already in progress', async () => {
    addItem('NEVER', 'PN-NEVER');
    await beginRun({ trigger: 'manual', scope: 'all' }, settings, deps());

    const outcome = await runAutoBulkPricing({}, deps());

    expect(outcome).toMatchObject({ ran: false, reason: 'A bulk pricing run is already in progress (run #1).' });
    expect(quoteCalls).toEqual([]);
  });

  it('skips the start-up catch-up when an automatic run happened recently', async () => {
    addItem('NEVER', 'PN-NEVER');
    db.state.runs.push({ id: 1, trigger: 'auto', status: 'completed', started_at: NOW - 3 * 3_600_000, heartbeat_at: NOW });

    const outcome = await runAutoBulkPricing({ onlyIfNoneSinceHours: 20 }, deps());

    expect(outcome).toMatchObject({ ran: false, reason: 'An automatic run already happened recently.' });
  });

  it('fires daily at 02:30 UTC', () => {
    expect(nextAutoRunAt(new Date('2026-10-06T01:00:00Z')).toISOString()).toBe('2026-10-06T02:30:00.000Z');
    expect(nextAutoRunAt(new Date('2026-10-06T02:30:00Z')).toISOString()).toBe('2026-10-07T02:30:00.000Z');
  });
});

describe('history clean-up', () => {
  it('removes history past the retention period and keeps each item’s last result', async () => {
    db.state.history = [41, 39, 2].map((days, i) => ({ id: i + 1, serial_number: 'A', created_at: NOW - days * DAY }));
    db.state.status.set('A', { last_success_at: NOW - 41 * DAY, last_status: 'updated' });

    const removed = await purgeHistory(40, deps());

    expect(removed).toBe(1);
    expect(db.state.history.map((h) => h.id)).toEqual([2, 3]);
    expect(db.state.status.get('A')).toMatchObject({ last_success_at: NOW - 41 * DAY });
  });

  it('never keeps less than 30 days', async () => {
    db.state.history = [31, 29].map((days, i) => ({ id: i + 1, created_at: NOW - days * DAY }));

    await purgeHistory(5, deps());

    expect(db.state.history.map((h) => h.id)).toEqual([2]);
  });

  it('runs as part of the daily job', async () => {
    db.state.history = [{ id: 1, created_at: NOW - 45 * DAY }];

    const outcome = await runAutoBulkPricing({}, deps());

    expect(outcome.purged).toBe(1);
  });
});
