// Bulk pricing engine.
//
// An item's "bulk price" is what a supplier charges per unit at the bulk
// quantity (1,000 by default). This module refreshes it from the supplier
// APIs, records every result, and keeps a per-item "last bulk priced" status
// that drives the automatic re-pricing.
//
// What a run writes on an item: bulk_price_zar and bulk_price_usd, nothing
// else. Not the stock count, not the part numbers or links, and not the main
// cost (current_cost_dollar), which bills and landed cost own. (The old
// "Apply live rates" wrote all of those back, from a copy of the item taken
// when the page loaded.)
//
// Layers, top to bottom:
//   settings    readSettings / parseSettings   (settings table, key bulkPricing)
//   selection   selectItems                    which items a run covers
//   pricing     chooseOffer                    pure: supplier quotes → one price
//   persistence applyItemResult                one transaction per item
//   runs        beginRun / processRun          one run at a time, logged
//   jobs        runAutoBulkPricing / purgeHistory
//
// Tables (created at boot by ensureBulkPricingSchema):
//   bulk_pricing_runs   one row per run (manual or auto): counts, status, timing
//   bulk_price_history  one row per item per run: old/new price, provider,
//                       status, error. Pruned after historyRetentionDays.
//   bulk_price_status   one row per item: its latest result. Never pruned, so
//                       "last bulk priced" survives the history clean-up.
//
// Why history retention defaults to 40 days, not 30: items are re-priced 35
// days after their last success. With 30-day retention the history of the
// previous change would be gone before the next one. The status table keeps
// the auto-run working whatever the retention; 40 days keeps the change
// history across a full cycle too.

import type { PoolClient } from 'pg';
import { pool, query, queryOne, exec } from './db';
import { quotePart, normaliseCurrency, type PartQuote } from './pricingRoutes';
import { readExchangeRate } from './exchangeRate';
import { bumpDataVersion } from './dataVersion';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface BulkPricingSettings {
  /** Run the daily job that re-prices items whose last bulk price is too old. */
  autoEnabled: boolean;
  /** Re-price an item once its last successful bulk price is this many days old. */
  autoThresholdDays: number;
  /** Keep price history for this many days (minimum 30). */
  historyRetentionDays: number;
  /** At most this many items per automatic run, to stay inside the supplier API quotas. */
  autoBatchSize: number;
  /** An item that got no price is tried again after this many days, not every day. */
  retryFailedAfterDays: number;
  /** The quantity prices are quoted at. */
  qty: number;
  /** A unit price above this (in USD) is held back for review: almost always a wrong match. */
  suspiciousAboveUsd: number;
}

export const DEFAULT_SETTINGS: BulkPricingSettings = {
  autoEnabled: true,
  autoThresholdDays: 35,
  historyRetentionDays: 40,
  autoBatchSize: 100,
  retryFailedAfterDays: 7,
  qty: 1000,
  suspiciousAboveUsd: 50,
};

const SETTINGS_KEY = 'bulkPricing';

const SETTING_RULES: Record<Exclude<keyof BulkPricingSettings, 'autoEnabled'>, { min: number; max: number; integer: boolean; label: string }> = {
  autoThresholdDays: { min: 1, max: 365, integer: true, label: 'Re-price after (days)' },
  historyRetentionDays: { min: 30, max: 3650, integer: true, label: 'Keep history for (days)' },
  autoBatchSize: { min: 1, max: 1000, integer: true, label: 'Items per automatic run' },
  retryFailedAfterDays: { min: 1, max: 365, integer: true, label: 'Retry unpriced items after (days)' },
  qty: { min: 1, max: 1_000_000, integer: true, label: 'Quote quantity' },
  suspiciousAboveUsd: { min: 0.01, max: 1_000_000, integer: false, label: 'Hold back above (USD)' },
};

/**
 * Validates a (partial) settings object over `base`. Returns the merged
 * settings, or the first problem. `warnings` are allowed but worth showing.
 */
export function parseSettings(
  input: unknown,
  base: BulkPricingSettings = DEFAULT_SETTINGS,
): { settings: BulkPricingSettings; warnings: string[] } | { error: string } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { error: 'Settings must be an object.' };
  const raw = input as Record<string, unknown>;
  const settings: BulkPricingSettings = { ...base };
  if ('autoEnabled' in raw) {
    if (typeof raw.autoEnabled !== 'boolean') return { error: 'autoEnabled must be true or false.' };
    settings.autoEnabled = raw.autoEnabled;
  }
  for (const [key, rule] of Object.entries(SETTING_RULES) as Array<[keyof typeof SETTING_RULES, (typeof SETTING_RULES)[keyof typeof SETTING_RULES]]>) {
    if (!(key in raw)) continue;
    const n = Number(raw[key]);
    if (!Number.isFinite(n) || (rule.integer && !Number.isInteger(n)) || n < rule.min || n > rule.max) {
      return { error: `${rule.label} must be ${rule.integer ? 'a whole number ' : ''}from ${rule.min} to ${rule.max}.` };
    }
    settings[key] = n;
  }
  const warnings: string[] = [];
  if (settings.historyRetentionDays < settings.autoThresholdDays) {
    warnings.push(`History is kept for ${settings.historyRetentionDays} days but items are re-priced after ${settings.autoThresholdDays}, so the record of each item's previous change will be gone before it is re-priced. Its last result is still kept.`);
  }
  return { settings, warnings };
}

export async function readSettings(): Promise<BulkPricingSettings> {
  const row = await queryOne<{ value: string }>(`SELECT value FROM settings WHERE key = $1`, [SETTINGS_KEY]);
  if (!row?.value) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = parseSettings(JSON.parse(row.value));
    return 'error' in parsed ? { ...DEFAULT_SETTINGS } : parsed.settings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: BulkPricingSettings, db: Pick<EngineDeps, 'query'> = { query }): Promise<void> {
  await db.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [SETTINGS_KEY, JSON.stringify(settings)]
  );
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export async function ensureBulkPricingSchema(run: (sql: string) => Promise<unknown> = exec): Promise<void> {
  await run(`CREATE TABLE IF NOT EXISTS bulk_pricing_runs (
    id SERIAL PRIMARY KEY,
    trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'auto')),
    scope TEXT NOT NULL,
    dry_run BOOLEAN NOT NULL DEFAULT FALSE,
    qty INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'running'
      CHECK (status IN ('running', 'completed', 'completed_with_errors', 'failed', 'stopped', 'interrupted')),
    stop_requested BOOLEAN NOT NULL DEFAULT FALSE,
    requested_by TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    total INTEGER NOT NULL DEFAULT 0,
    checked INTEGER NOT NULL DEFAULT 0,
    updated INTEGER NOT NULL DEFAULT 0,
    unchanged INTEGER NOT NULL DEFAULT 0,
    flagged INTEGER NOT NULL DEFAULT 0,
    no_price INTEGER NOT NULL DEFAULT 0,
    skipped INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    note TEXT
  )`);
  // At most one run in progress at a time, across every server machine.
  // (A table-level guard rather than a Postgres advisory lock, which isn't
  // reliable through Neon's connection pooler.)
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS bulk_pricing_one_running ON bulk_pricing_runs ((true)) WHERE status = 'running'`);
  await run(`CREATE INDEX IF NOT EXISTS bulk_pricing_runs_started ON bulk_pricing_runs (started_at DESC)`);

  await run(`CREATE TABLE IF NOT EXISTS bulk_price_history (
    id BIGSERIAL PRIMARY KEY,
    run_id INTEGER REFERENCES bulk_pricing_runs(id) ON DELETE SET NULL,
    serial_number TEXT NOT NULL,
    part_number TEXT,
    source TEXT NOT NULL CHECK (source IN ('manual', 'auto')),
    dry_run BOOLEAN NOT NULL DEFAULT FALSE,
    status TEXT NOT NULL,
    old_price_zar NUMERIC(18,4),
    new_price_zar NUMERIC(18,4),
    old_price_usd NUMERIC(18,4),
    new_price_usd NUMERIC(18,4),
    provider TEXT,
    matched_part TEXT,
    native_price NUMERIC(18,6),
    native_currency TEXT,
    qty INTEGER,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await run(`CREATE INDEX IF NOT EXISTS bulk_price_history_created ON bulk_price_history (created_at)`);
  await run(`CREATE INDEX IF NOT EXISTS bulk_price_history_item ON bulk_price_history (serial_number, created_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS bulk_price_history_run ON bulk_price_history (run_id)`);

  await run(`CREATE TABLE IF NOT EXISTS bulk_price_status (
    serial_number TEXT PRIMARY KEY,
    last_attempt_at TIMESTAMPTZ,
    last_success_at TIMESTAMPTZ,
    last_run_id INTEGER,
    last_source TEXT,
    last_status TEXT,
    last_old_price_zar NUMERIC(18,4),
    last_new_price_zar NUMERIC(18,4),
    last_error TEXT
  )`);
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export type RunScope = 'due' | 'missing' | 'all' | 'selected';
export const RUN_SCOPES: RunScope[] = ['due', 'missing', 'all', 'selected'];

export interface PricingItem {
  serialNumber: string;
  name: string | null;
  /**
   * The part number sent to the suppliers: the first real manufacturer part
   * number (man_pn_1..5), else the first supplier part number (sup_pn_1..5:
   * Mouser, DigiKey, LCSC, ...). Null if the item has none.
   */
  partNumber: string | null;
  bulkPriceZar: number | null;
  bulkPriceUsd: number | null;
}

// The part number an item is priced by (see PricingItem.partNumber), skipping
// placeholders such as "N/A".
export const PART_NUMBER_SQL = `(SELECT TRIM(v) FROM unnest(ARRAY[i.man_pn_1, i.man_pn_2, i.man_pn_3, i.man_pn_4, i.man_pn_5,
    i.sup_pn_1, i.sup_pn_2, i.sup_pn_3, i.sup_pn_4, i.sup_pn_5]) WITH ORDINALITY AS t(v, n)
  WHERE COALESCE(TRIM(v), '') <> '' AND UPPER(TRIM(v)) NOT IN ('N/A', 'NA', 'N', 'GENERIC', '-') ORDER BY n LIMIT 1)`;

// Due: not priced successfully within the threshold, and not a recent
// failure still inside its retry wait.
export const DUE_SQL = `(s.last_success_at IS NULL OR s.last_success_at < now() - make_interval(days => $1::int))
  AND NOT (s.last_attempt_at IS NOT NULL AND (s.last_success_at IS NULL OR s.last_attempt_at > s.last_success_at)
           AND s.last_attempt_at > now() - make_interval(days => $2::int))`;

/** No usable bulk price: empty, zero, or not a number (the column is text). */
export const missingPriceSql = (column: string) =>
  `(CASE WHEN TRIM(${column}::text) ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN TRIM(${column}::text)::numeric ELSE 0 END) = 0`;

export interface PricingStatus {
  lastAttemptAt: Date | string | null;
  lastSuccessAt: Date | string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const toTime = (v: Date | string | null) => (v === null ? null : new Date(v).getTime());

/**
 * The same rule as DUE_SQL, for showing "next due" and for tests: due when
 * never priced successfully or last priced over autoThresholdDays ago, unless
 * the last attempt failed less than retryFailedAfterDays ago.
 */
export function isDue(status: PricingStatus | null, now: Date, settings: Pick<BulkPricingSettings, 'autoThresholdDays' | 'retryFailedAfterDays'>): boolean {
  const success = status ? toTime(status.lastSuccessAt) : null;
  const attempt = status ? toTime(status.lastAttemptAt) : null;
  const stale = success === null || success < now.getTime() - settings.autoThresholdDays * DAY_MS;
  const failedLast = attempt !== null && (success === null || attempt > success);
  const waiting = failedLast && (attempt as number) > now.getTime() - settings.retryFailedAfterDays * DAY_MS;
  return stale && !waiting;
}

/** When an item next becomes due (null when it already is). */
export function nextDueAt(status: PricingStatus | null, now: Date, settings: Pick<BulkPricingSettings, 'autoThresholdDays' | 'retryFailedAfterDays'>): Date | null {
  if (isDue(status, now, settings)) return null;
  const success = status ? toTime(status.lastSuccessAt) : null;
  const attempt = status ? toTime(status.lastAttemptAt) : null;
  const byAge = success === null ? now.getTime() : success + settings.autoThresholdDays * DAY_MS;
  const failedLast = attempt !== null && (success === null || attempt > success);
  const byRetry = failedLast ? (attempt as number) + settings.retryFailedAfterDays * DAY_MS : 0;
  return new Date(Math.max(byAge, byRetry));
}

/** A price stored as text ('' and junk become null). */
export function priceOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export interface SelectOptions {
  settings: BulkPricingSettings;
  /** For the 'selected' scope: the items' stock codes. */
  serialNumbers?: string[];
  limit?: number;
}

export async function selectItems(
  scope: RunScope,
  options: SelectOptions,
  db: { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> } = { query },
): Promise<PricingItem[]> {
  const { settings } = options;
  const limit = Math.max(1, Math.min(5000, options.limit ?? 5000));
  let where: string;
  let params: any[];
  let order: string;
  switch (scope) {
    case 'selected':
      // Selected items are returned even without a part number, so the
      // summary can say they were skipped and why.
      where = `i.serial_number = ANY($1::text[])`;
      params = [options.serialNumbers ?? []];
      order = 'i.serial_number';
      break;
    case 'due':
      where = `${PART_NUMBER_SQL} IS NOT NULL AND ${DUE_SQL}`;
      params = [settings.autoThresholdDays, settings.retryFailedAfterDays];
      order = 's.last_success_at ASC NULLS FIRST, i.serial_number';
      break;
    case 'missing':
      where = `${PART_NUMBER_SQL} IS NOT NULL AND ${missingPriceSql('i.bulk_price_zar')}`;
      params = [];
      order = 'i.serial_number';
      break;
    case 'all':
      where = `${PART_NUMBER_SQL} IS NOT NULL`;
      params = [];
      order = 'i.serial_number';
      break;
  }
  const { rows } = await db.query(
    `SELECT i.serial_number, i.name, ${PART_NUMBER_SQL} AS part_number, i.bulk_price_zar, i.bulk_price_usd
       FROM inventory i LEFT JOIN bulk_price_status s ON s.serial_number = i.serial_number
      WHERE i.deleted IS NOT TRUE AND ${where}
      ORDER BY ${order}
      LIMIT ${limit}`,
    params
  );
  return rows.map((r) => ({
    serialNumber: r.serial_number,
    name: r.name ?? null,
    partNumber: r.part_number ?? null,
    bulkPriceZar: priceOrNull(r.bulk_price_zar),
    bulkPriceUsd: priceOrNull(r.bulk_price_usd),
  }));
}

// ---------------------------------------------------------------------------
// Pricing: supplier quotes → the one price to store (pure)
// ---------------------------------------------------------------------------

export interface Fx {
  usdToZar: number | null;
  ratesToZar: Record<string, number>;
}

export interface Offer {
  provider: string;
  nativePrice: number;
  currency: string;
  zar: number;
  usd: number;
  matchedPart: string | null;
}

export type OfferChoice =
  | { kind: 'offer'; offer: Offer }
  | { kind: 'flagged'; offer: Offer; reason: string }
  | { kind: 'no_price'; reason: string; transient: boolean; quotaExhausted: boolean };

const OFFER_PROVIDERS = ['digikey', 'mouser', 'lcsc', 'nexar', 'element14', 'tme'];
const TRANSIENT_ERROR = /fetch failed|timed? ?out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network|\b5\d\d\b|Service Unavailable|Bad Gateway|Too Many Requests|\b429\b/i;

export function isTransientError(message: string): boolean {
  return TRANSIENT_ERROR.test(message);
}

/**
 * Picks the cheapest usable supplier price for a quote and converts it to
 * ZAR and USD. Prices quoted in a currency with no stored rate are left out
 * rather than guessed. The cheapest price is held back when it is above the
 * suspicious threshold: on this catalogue (mostly passives) that is almost
 * always a keyword search matching the wrong part.
 */
export function chooseOffer(quote: PartQuote, fx: Fx, suspiciousAboveUsd: number): OfferChoice {
  const offers: Offer[] = [];
  const problems: string[] = [];
  for (const provider of OFFER_PROVIDERS) {
    const raw = quote?.[provider];
    if (!raw) continue;
    const price = Number(raw.unitPrice);
    if (!Number.isFinite(price) || price <= 0) {
      if (raw.error) problems.push(`${provider}: ${raw.error}`);
      continue;
    }
    const currency = normaliseCurrency(raw.currency);
    const rate = currency === 'ZAR' ? 1 : fx.ratesToZar[currency];
    if (!Number.isFinite(rate) || rate <= 0 || !fx.usdToZar) {
      problems.push(`${provider}: quoted in ${currency}, which has no stored exchange rate`);
      continue;
    }
    const zar = price * rate;
    offers.push({
      provider,
      nativePrice: price,
      currency,
      zar: Number(zar.toFixed(4)),
      usd: Number((zar / fx.usdToZar).toFixed(4)),
      matchedPart: raw.partNumber ?? null,
    });
  }

  if (!offers.length) {
    const quotaExhausted = problems.length > 0 && problems.every((p) => /daily limit reached|not configured|not authori[sz]ed|skipped/i.test(p))
      && problems.some((p) => /daily limit reached/i.test(p));
    const transient = problems.some((p) => isTransientError(p));
    const meaningful = problems.filter((p) => !/not configured|skipped: lcsc/i.test(p));
    const reason = quotaExhausted
      ? 'Daily supplier API limit reached; it will be tried again on the next run.'
      : meaningful.length ? `No price found (${meaningful.slice(0, 3).join('; ')})` : 'No price found at any supplier.';
    return { kind: 'no_price', reason, transient, quotaExhausted };
  }

  const best = offers.reduce((a, b) => (b.zar < a.zar ? b : a));
  if (best.usd > suspiciousAboveUsd) {
    return {
      kind: 'flagged',
      offer: best,
      reason: `Cheapest price, ${best.usd} USD from ${best.provider}${best.matchedPart ? ` (matched ${best.matchedPart})` : ''}, is above the ${suspiciousAboveUsd} USD review threshold, so it was held back: likely the wrong part.`,
    };
  }
  return { kind: 'offer', offer: best };
}

// ---------------------------------------------------------------------------
// Persistence: one transaction per item
// ---------------------------------------------------------------------------

export type ItemStatus = 'updated' | 'unchanged' | 'flagged' | 'no_price' | 'skipped' | 'failed';

export interface ItemResult {
  serialNumber: string;
  partNumber: string | null;
  status: ItemStatus;
  oldPriceZar: number | null;
  newPriceZar: number | null;
  oldPriceUsd: number | null;
  newPriceUsd: number | null;
  provider: string | null;
  reason: string | null;
}

interface RunContext {
  runId: number;
  source: 'manual' | 'auto';
  dryRun: boolean;
  qty: number;
}

const samePrice = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) < 0.00005;

/**
 * Writes one item's result: the new bulk price (only if it changed, and not
 * on a dry run), a history row, and the item's status. All or nothing.
 * The item's current price is read under a row lock, so two writers can't
 * interleave and the recorded old price is the one actually replaced.
 */
export async function applyItemResult(
  client: Pick<PoolClient, 'query'>,
  item: PricingItem,
  choice: OfferChoice | { kind: 'skipped' | 'failed'; reason: string },
  ctx: RunContext,
): Promise<ItemResult> {
  await client.query('BEGIN');
  try {
    const locked = await client.query(
      `SELECT bulk_price_zar, bulk_price_usd FROM inventory WHERE serial_number = $1 FOR UPDATE`,
      [item.serialNumber]
    );
    const result: ItemResult = {
      serialNumber: item.serialNumber,
      partNumber: item.partNumber,
      status: 'failed',
      oldPriceZar: null, newPriceZar: null, oldPriceUsd: null, newPriceUsd: null,
      provider: null,
      reason: null,
    };
    let offer: Offer | null = null;
    if (locked.rows.length === 0) {
      result.reason = 'The item no longer exists.';
    } else {
      result.oldPriceZar = priceOrNull(locked.rows[0].bulk_price_zar);
      result.oldPriceUsd = priceOrNull(locked.rows[0].bulk_price_usd);
      if (choice.kind === 'offer') {
        offer = choice.offer;
        result.newPriceZar = offer.zar;
        result.newPriceUsd = offer.usd;
        result.provider = offer.provider;
        const changed = !samePrice(result.oldPriceZar, offer.zar) || !samePrice(result.oldPriceUsd, offer.usd);
        result.status = changed ? 'updated' : 'unchanged';
        if (changed && !ctx.dryRun) {
          await client.query(
            `UPDATE inventory SET bulk_price_zar = $1, bulk_price_usd = $2 WHERE serial_number = $3`,
            [String(offer.zar), String(offer.usd), item.serialNumber]
          );
        }
      } else if (choice.kind === 'flagged') {
        offer = choice.offer;
        result.status = 'flagged';
        result.provider = offer.provider;
        result.newPriceZar = offer.zar;
        result.newPriceUsd = offer.usd;
        result.reason = choice.reason;
      } else if (choice.kind === 'no_price') {
        result.status = choice.quotaExhausted ? 'skipped' : 'no_price';
        result.reason = choice.reason;
      } else {
        result.status = choice.kind;
        result.reason = choice.reason;
      }
    }

    await client.query(
      `INSERT INTO bulk_price_history (run_id, serial_number, part_number, source, dry_run, status,
         old_price_zar, new_price_zar, old_price_usd, new_price_usd, provider, matched_part, native_price, native_currency, qty, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [ctx.runId, item.serialNumber, item.partNumber, ctx.source, ctx.dryRun, result.status,
        result.oldPriceZar, result.newPriceZar, result.oldPriceUsd, result.newPriceUsd,
        result.provider, offer?.matchedPart ?? null, offer?.nativePrice ?? null, offer?.currency ?? null, ctx.qty, result.reason]
    );

    // A dry run changes nothing that matters later. A skip (no part number,
    // or the API quota ran out) isn't a real attempt either: leave the item
    // due so the next run picks it up.
    if (!ctx.dryRun && result.status !== 'skipped' && locked.rows.length > 0) {
      const succeeded = result.status === 'updated' || result.status === 'unchanged';
      await client.query(
        `INSERT INTO bulk_price_status (serial_number, last_attempt_at, last_success_at, last_run_id, last_source, last_status,
           last_old_price_zar, last_new_price_zar, last_error)
         VALUES ($1, now(), CASE WHEN $2::boolean THEN now() END, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (serial_number) DO UPDATE SET
           last_attempt_at = now(),
           last_success_at = CASE WHEN $2::boolean THEN now() ELSE bulk_price_status.last_success_at END,
           last_run_id = EXCLUDED.last_run_id,
           last_source = EXCLUDED.last_source,
           last_status = EXCLUDED.last_status,
           last_old_price_zar = CASE WHEN $2::boolean THEN EXCLUDED.last_old_price_zar ELSE bulk_price_status.last_old_price_zar END,
           last_new_price_zar = CASE WHEN $2::boolean THEN EXCLUDED.last_new_price_zar ELSE bulk_price_status.last_new_price_zar END,
           last_error = EXCLUDED.last_error`,
        [item.serialNumber, succeeded, ctx.runId, ctx.source, result.status,
          succeeded ? result.oldPriceZar : null, succeeded ? result.newPriceZar : null, result.reason]
      );
    }
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export class RunInProgressError extends Error {
  constructor(public readonly runId: number | null, public readonly startedAt: string | null) {
    super(`A bulk pricing run is already in progress${runId ? ` (run #${runId})` : ''}.`);
    this.name = 'RunInProgressError';
  }
}

export interface RunOptions {
  trigger: 'manual' | 'auto';
  scope: RunScope;
  dryRun?: boolean;
  /** For the 'selected' scope: the items' stock codes. */
  serialNumbers?: string[];
  qty?: number;
  limit?: number;
  requestedBy?: string | null;
}

export interface RunCounts {
  total: number;
  checked: number;
  updated: number;
  unchanged: number;
  flagged: number;
  noPrice: number;
  skipped: number;
  failed: number;
}

export interface RunSummary extends RunCounts {
  runId: number;
  trigger: 'manual' | 'auto';
  scope: RunScope;
  dryRun: boolean;
  qty: number;
  status: 'completed' | 'completed_with_errors' | 'failed' | 'stopped';
  error: string | null;
  note: string | null;
  /** Each distinct reason items were not updated, with how many items it applied to. */
  reasons: Array<{ status: ItemStatus; reason: string; count: number }>;
  items: ItemResult[];
}

export interface EngineDeps {
  readSettings: () => Promise<BulkPricingSettings>;
  readFx: () => Promise<Fx>;
  selectItems: (scope: RunScope, options: SelectOptions) => Promise<PricingItem[]>;
  quote: (partNumber: string, qty: number, maxAgeMs: number) => Promise<PartQuote>;
  connect: () => Promise<Pick<PoolClient, 'query' | 'release'>>;
  query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number }>;
  sleep: (ms: number) => Promise<void>;
  /** Tells open browser tabs that inventory changed, so they reload it. */
  notifyChanged: () => Promise<void>;
}

export const defaultEngineDeps: EngineDeps = {
  readSettings,
  readFx: readExchangeRate,
  selectItems: (scope, options) => selectItems(scope, options),
  quote: (partNumber, qty, maxAgeMs) => quotePart(partNumber, qty, maxAgeMs),
  connect: () => pool.connect(),
  query: (text, params) => query(text, params),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  notifyChanged: () => bumpDataVersion('inventory'),
};

/** How long a run may go without a heartbeat before it counts as abandoned. */
export const STALE_RUN_MINUTES = 10;
/** A running run's heartbeat interval, independent of how long one item takes. */
const HEARTBEAT_MS = 60_000;
/** A supplier lookup that hasn't answered by then counts as failed (and is retried). */
const QUOTE_TIMEOUT_MS = 2 * 60_000;
const QUOTE_ATTEMPTS = 3;
const SAVE_ATTEMPTS = 3;
const emptyCounts = (): RunCounts => ({ total: 0, checked: 0, updated: 0, unchanged: 0, flagged: 0, noPrice: 0, skipped: 0, failed: 0 });

/**
 * Claims the single run slot and records the run. Throws RunInProgressError
 * when another run holds it. A run whose server stopped mid-way (no
 * heartbeat for STALE_RUN_MINUTES) is marked interrupted first, so a crash
 * never blocks pricing for good.
 */
export async function beginRun(options: RunOptions, settings: BulkPricingSettings, deps: Pick<EngineDeps, 'query'> = defaultEngineDeps): Promise<number> {
  await deps.query(
    `UPDATE bulk_pricing_runs SET status = 'interrupted', finished_at = now(),
       error = 'The server stopped before this run finished.'
     WHERE status = 'running' AND heartbeat_at < now() - make_interval(mins => $1::int)`,
    [STALE_RUN_MINUTES]
  );
  try {
    const { rows } = await deps.query(
      `INSERT INTO bulk_pricing_runs (trigger, scope, dry_run, qty, requested_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [options.trigger, options.scope, !!options.dryRun, options.qty ?? settings.qty, options.requestedBy ?? null]
    );
    return rows[0].id;
  } catch (err: any) {
    if (err?.code === '23505') {
      const { rows } = await deps.query(`SELECT id, started_at FROM bulk_pricing_runs WHERE status = 'running' LIMIT 1`).catch(() => ({ rows: [] as any[] }));
      throw new RunInProgressError(rows[0]?.id ?? null, rows[0]?.started_at ?? null);
    }
    throw err;
  }
}

/** Records progress and the heartbeat. Returns true when someone asked the run to stop. */
async function saveProgress(runId: number, counts: RunCounts, deps: Pick<EngineDeps, 'query'>): Promise<boolean> {
  const { rows } = await deps.query(
    `UPDATE bulk_pricing_runs SET heartbeat_at = now(), total = $2, checked = $3, updated = $4, unchanged = $5,
       flagged = $6, no_price = $7, skipped = $8, failed = $9 WHERE id = $1 RETURNING stop_requested`,
    [runId, counts.total, counts.checked, counts.updated, counts.unchanged, counts.flagged, counts.noPrice, counts.skipped, counts.failed]
  );
  return rows[0]?.stop_requested === true;
}

/**
 * Asks a running run to stop. It finishes the item in hand, then stops.
 * Returns false when the run isn't running.
 */
export async function requestStop(runId: number, deps: Pick<EngineDeps, 'query'> = defaultEngineDeps): Promise<boolean> {
  const { rowCount } = await deps.query(
    `UPDATE bulk_pricing_runs SET stop_requested = TRUE WHERE id = $1 AND status = 'running'`,
    [runId]
  );
  return rowCount > 0;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    (timer as any)?.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Quotes one item, retrying when every supplier failed for a transient reason. */
async function quoteItem(item: PricingItem, qty: number, settings: BulkPricingSettings, fx: Fx, deps: EngineDeps): Promise<OfferChoice | { kind: 'failed'; reason: string }> {
  // Supplier answers are cached for 30 days; an item due for re-pricing
  // (default 35 days) is older than that, so it is asked afresh.
  const maxAgeMs = 30 * 24 * 60 * 60 * 1000;
  let last: OfferChoice | { kind: 'failed'; reason: string } = { kind: 'failed', reason: 'Not attempted' };
  for (let attempt = 1; attempt <= QUOTE_ATTEMPTS; attempt++) {
    try {
      const quote = await withTimeout(deps.quote(item.partNumber as string, qty, maxAgeMs), QUOTE_TIMEOUT_MS, 'the suppliers did not answer within 2 minutes');
      last = chooseOffer(quote, fx, settings.suspiciousAboveUsd);
      if (last.kind !== 'no_price' || !last.transient) return last;
    } catch (err: any) {
      last = { kind: 'failed', reason: `Supplier lookup failed: ${err?.message || err}` };
    }
    if (attempt < QUOTE_ATTEMPTS) await deps.sleep(1000 * 3 ** (attempt - 1));
  }
  if (last.kind === 'no_price') last = { ...last, reason: `${last.reason} (after ${QUOTE_ATTEMPTS} tries)` };
  return last;
}

/** Prices one item and saves the result. Never throws: a failure is a result. */
async function priceItem(item: PricingItem, ctx: RunContext, settings: BulkPricingSettings, fx: Fx, deps: EngineDeps): Promise<ItemResult> {
  const choice = item.partNumber
    ? await quoteItem(item, ctx.qty, settings, fx, deps)
    : { kind: 'skipped' as const, reason: 'No manufacturer or supplier part number to look up.' };

  let lastError: any = null;
  for (let attempt = 1; attempt <= SAVE_ATTEMPTS; attempt++) {
    let client: Pick<PoolClient, 'query' | 'release'> | null = null;
    try {
      client = await deps.connect();
      return await applyItemResult(client, item, choice, ctx);
    } catch (err) {
      lastError = err;
      if (attempt < SAVE_ATTEMPTS) await deps.sleep(500 * attempt);
    } finally {
      client?.release();
    }
  }
  return {
    serialNumber: item.serialNumber, partNumber: item.partNumber, status: 'failed',
    oldPriceZar: item.bulkPriceZar, newPriceZar: null, oldPriceUsd: item.bulkPriceUsd, newPriceUsd: null,
    provider: null, reason: `Could not save: ${lastError?.message || lastError}`,
  };
}

function tally(counts: RunCounts, result: ItemResult) {
  counts.checked += 1;
  if (result.status === 'updated') counts.updated += 1;
  else if (result.status === 'unchanged') counts.unchanged += 1;
  else if (result.status === 'flagged') counts.flagged += 1;
  else if (result.status === 'no_price') counts.noPrice += 1;
  else if (result.status === 'skipped') counts.skipped += 1;
  else counts.failed += 1;
}

/** Each distinct reason items were not updated, most common first. */
export function groupReasons(items: Array<Pick<ItemResult, 'status' | 'reason'>>): RunSummary['reasons'] {
  const map = new Map<string, { status: ItemStatus; reason: string; count: number }>();
  for (const it of items) {
    if (!it.reason || it.status === 'updated' || it.status === 'unchanged') continue;
    // Group by the reason's wording without the per-part detail in brackets.
    const reason = it.reason.replace(/\s*\(.*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    const key = `${it.status}|${reason}`;
    const entry = map.get(key) ?? { status: it.status, reason, count: 0 };
    entry.count += 1;
    map.set(key, entry);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

/**
 * Prices the run's items one by one and logs progress as it goes. A run
 * always finishes with a status; one item's failure never stops the rest.
 */
export async function processRun(runId: number, options: RunOptions, deps: EngineDeps = defaultEngineDeps): Promise<RunSummary> {
  const counts = emptyCounts();
  const items: ItemResult[] = [];
  const dryRun = !!options.dryRun;
  let settings: BulkPricingSettings = DEFAULT_SETTINGS;
  let qty = options.qty ?? DEFAULT_SETTINGS.qty;
  const finish = async (status: RunSummary['status'], error: string | null, note: string | null): Promise<RunSummary> => {
    await deps.query(
      `UPDATE bulk_pricing_runs SET status = $2, finished_at = now(), heartbeat_at = now(), total = $3, checked = $4, updated = $5,
         unchanged = $6, flagged = $7, no_price = $8, skipped = $9, failed = $10, error = $11, note = $12 WHERE id = $1`,
      [runId, status, counts.total, counts.checked, counts.updated, counts.unchanged, counts.flagged, counts.noPrice, counts.skipped, counts.failed, error, note]
    ).catch((err) => console.error(`[BULK PRICING] run #${runId}: could not record the result:`, err.message));
    if (counts.updated > 0 && !dryRun) await deps.notifyChanged().catch(() => {});
    return { runId, trigger: options.trigger, scope: options.scope, dryRun, qty, status, error, note, ...counts, reasons: groupReasons(items), items };
  };

  // Keeps the run visibly alive while a slow supplier lookup is in progress,
  // so it is never mistaken for an abandoned run and overlapped.
  const heartbeat = setInterval(() => {
    deps.query(`UPDATE bulk_pricing_runs SET heartbeat_at = now() WHERE id = $1 AND status = 'running'`, [runId]).catch(() => {});
  }, HEARTBEAT_MS);
  (heartbeat as any)?.unref?.();

  try {
    settings = await deps.readSettings();
    qty = options.qty ?? settings.qty;
    const fx = await deps.readFx();
    if (!fx.usdToZar) {
      return await finish('failed', 'No USD to ZAR exchange rate is stored. Refresh the exchange rate, then run again.', null);
    }
    const selected = await deps.selectItems(options.scope, { settings, serialNumbers: options.serialNumbers, limit: options.limit });
    counts.total = selected.length;
    await saveProgress(runId, counts, deps);
    if (selected.length === 0) {
      return await finish('completed', null, options.scope === 'due' ? 'Nothing was due for re-pricing.' : 'No items to price.');
    }

    const ctx: RunContext = { runId, source: options.trigger, dryRun, qty };
    for (const item of selected) {
      const result = await priceItem(item, ctx, settings, fx, deps);
      items.push(result);
      tally(counts, result);
      // Progress is best-effort: the item's result is already saved.
      const stopRequested = await saveProgress(runId, counts, deps).catch(() => false);
      if (stopRequested && counts.checked < counts.total) {
        return await finish('stopped', null, `Stopped on request after ${counts.checked} of ${counts.total} items.`);
      }
    }
    const note = dryRun ? 'Preview only: nothing was written.' : null;
    return await finish(counts.failed > 0 ? 'completed_with_errors' : 'completed', null, note);
  } catch (err: any) {
    console.error(`[BULK PRICING] run #${runId} failed:`, err?.message || err);
    return await finish('failed', err?.message || String(err), null);
  } finally {
    clearInterval(heartbeat);
  }
}

/** Claims the run slot, then prices everything (for callers that want to wait). */
export async function runBulkPricing(options: RunOptions, deps: EngineDeps = defaultEngineDeps): Promise<RunSummary> {
  const settings = await deps.readSettings();
  const runId = await beginRun(options, settings, deps);
  return processRun(runId, options, deps);
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/** The daily automatic run fires at this time, UTC (04:30 in South Africa). */
export const AUTO_RUN_CRON = '30 2 * * *';

export function nextAutoRunAt(from: Date = new Date()): Date {
  const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 2, 30, 0));
  if (next.getTime() <= from.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

/** Deletes price history older than the retention period. Returns the number of rows removed. */
export async function purgeHistory(retentionDays: number, deps: Pick<EngineDeps, 'query'> = defaultEngineDeps): Promise<number> {
  const days = Math.max(30, Math.floor(retentionDays));
  const { rowCount } = await deps.query(
    `DELETE FROM bulk_price_history WHERE created_at < now() - make_interval(days => $1::int)`,
    [days]
  );
  return rowCount;
}

export interface AutoRunOutcome {
  ran: boolean;
  reason: string | null;
  purged: number;
  summary: RunSummary | null;
  nextRunAt: string;
}

/**
 * The scheduled job: clears expired history, then re-prices the items whose
 * last successful bulk price is older than the threshold, oldest first, up to
 * the batch size. Every check is logged as a run, including "nothing due".
 * `onlyIfNoneSince` lets the start-up catch-up skip when a run already
 * happened recently.
 */
export async function runAutoBulkPricing(
  options: { onlyIfNoneSinceHours?: number } = {},
  deps: EngineDeps = defaultEngineDeps,
): Promise<AutoRunOutcome> {
  const nextRunAt = nextAutoRunAt().toISOString();
  const settings = await deps.readSettings();
  const purged = await purgeHistory(settings.historyRetentionDays, deps);
  if (!settings.autoEnabled) {
    return { ran: false, reason: 'Automatic bulk pricing is turned off.', purged, summary: null, nextRunAt };
  }
  if (options.onlyIfNoneSinceHours) {
    const { rows } = await deps.query(
      `SELECT 1 FROM bulk_pricing_runs WHERE trigger = 'auto' AND started_at > now() - make_interval(hours => $1::int) LIMIT 1`,
      [options.onlyIfNoneSinceHours]
    );
    if (rows.length) return { ran: false, reason: 'An automatic run already happened recently.', purged, summary: null, nextRunAt };
  }

  const runOptions: RunOptions = { trigger: 'auto', scope: 'due', limit: settings.autoBatchSize, requestedBy: 'schedule' };
  console.log(`[BULK PRICING] automatic run starting: items last priced over ${settings.autoThresholdDays} days ago, up to ${settings.autoBatchSize}.`);
  try {
    const summary = await runBulkPricing(runOptions, deps);
    console.log(`[BULK PRICING] automatic run #${summary.runId} ${summary.status}: ${summary.checked} checked, ${summary.updated} updated, ${summary.unchanged} unchanged, `
      + `${summary.flagged} held back, ${summary.noPrice} without a price, ${summary.skipped} skipped, ${summary.failed} failed. Next run ${nextRunAt}.`);
    return { ran: true, reason: null, purged, summary, nextRunAt };
  } catch (err) {
    if (err instanceof RunInProgressError) {
      console.log(`[BULK PRICING] automatic run skipped: ${err.message}`);
      return { ran: false, reason: err.message, purged, summary: null, nextRunAt };
    }
    throw err;
  }
}
