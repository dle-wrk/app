// Bulk pricing problem review: the items whose last result was held back, got
// no price, or failed, with every supplier's answer to compare, and the
// decisions a person can take on each.
//
//   GET  /api/pricing/bulk-review                     the problem items (?kind=flagged|no_price|failed)
//   POST /api/pricing/bulk-review/:serial/recheck     ask the suppliers again now; changes no price
//   POST /api/pricing/bulk-review/:serial/approve     use a supplier's price from the latest result
//   POST /api/pricing/bulk-review/:serial/reject      keep the current price
//   POST /api/pricing/bulk-review/:serial/price       set the bulk price by hand (rand)
//   POST /api/pricing/bulk-review/:serial/exclude     leave the item out of bulk pricing, or put it back
//
// Every POST needs a role that may change inventory, and is recorded in the
// item's bulk price history with who decided. A decision counts as the item's
// latest bulk pricing: it leaves the problem list and is next due when the
// re-price interval has passed. Excluded items are left out of runs (unless
// ticked) and of the due and problem lists.

import type { Express } from 'express';
import type { PoolClient } from 'pg';
import { requirePermission } from './authRoutes';
import {
  LCSC_CODE_SQL, PART_NUMBER_SQL, chooseOffer, defaultEngineDeps, priceOrNull, summariseQuote,
  type EngineDeps, type QuoteAnswer,
} from './bulkPricing';

export type ProblemKind = 'flagged' | 'no_price' | 'failed';
const PROBLEM_KINDS: ProblemKind[] = ['flagged', 'no_price', 'failed'];

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(v as any).toISOString());
const RECHECK_MAX_AGE_MS = 60_000; // a re-check asks the suppliers afresh

function mapEntry(r: any) {
  return {
    serialNumber: r.serial_number,
    name: r.name ?? null,
    partNumber: r.part_number ?? null,
    lcscCode: r.lcsc_code ?? null,
    bulkPriceZar: priceOrNull(r.bulk_price_zar),
    bulkPriceUsd: priceOrNull(r.bulk_price_usd),
    problem: r.last_status as ProblemKind,
    reason: r.last_error ?? null,
    lastAttemptAt: iso(r.last_attempt_at),
    result: r.history_id === null || r.history_id === undefined ? null : {
      historyId: Number(r.history_id),
      status: r.result_status as string,
      at: iso(r.result_at),
      runId: r.run_id === null || r.run_id === undefined ? null : Number(r.run_id),
      /** A re-check from the review: shown, but it changed nothing. */
      recheck: r.dry_run === true && (r.run_id === null || r.run_id === undefined),
      preview: r.dry_run === true && r.run_id !== null && r.run_id !== undefined,
      decidedBy: r.decided_by ?? null,
      provider: r.provider ?? null,
      matchedPart: r.matched_part ?? null,
      proposedZar: priceOrNull(r.new_price_zar),
      proposedUsd: priceOrNull(r.new_price_usd),
      reason: r.result_error ?? null,
      answers: Array.isArray(r.offers) ? (r.offers as QuoteAnswer[]) : null,
    },
  };
}
export type ReviewEntry = ReturnType<typeof mapEntry>;

// The problem items with their latest result. `extra` narrows it ($1 = serial, or kind).
function reviewSql(extra: string): string {
  return `
    SELECT i.serial_number, i.name, ${PART_NUMBER_SQL} AS part_number, ${LCSC_CODE_SQL} AS lcsc_code,
           i.bulk_price_zar, i.bulk_price_usd, s.last_status, s.last_error, s.last_attempt_at,
           h.id AS history_id, h.status AS result_status, h.created_at AS result_at, h.run_id, h.dry_run, h.decided_by,
           h.provider, h.matched_part, h.new_price_zar, h.new_price_usd, h.error AS result_error, h.offers
      FROM inventory i
      JOIN bulk_price_status s ON s.serial_number = i.serial_number
      LEFT JOIN LATERAL (
        SELECT x.* FROM bulk_price_history x WHERE x.serial_number = i.serial_number ORDER BY x.created_at DESC, x.id DESC LIMIT 1
      ) h ON TRUE
     WHERE i.deleted IS NOT TRUE AND s.excluded IS NOT TRUE AND s.last_status IN ('flagged', 'no_price', 'failed') ${extra}
     ORDER BY CASE s.last_status WHEN 'flagged' THEN 0 WHEN 'no_price' THEN 1 ELSE 2 END, i.serial_number`;
}

export async function listProblems(kind: ProblemKind | null, deps: Pick<EngineDeps, 'query'> = defaultEngineDeps) {
  const { rows } = await deps.query(reviewSql(kind ? 'AND s.last_status = $1' : ''), kind ? [kind] : []);
  const entries = rows.map(mapEntry);
  const { rows: countRows } = await deps.query(
    `SELECT s.last_status, COUNT(*)::int AS n FROM bulk_price_status s JOIN inventory i ON i.serial_number = s.serial_number
      WHERE i.deleted IS NOT TRUE AND s.excluded IS NOT TRUE AND s.last_status IN ('flagged', 'no_price', 'failed') GROUP BY 1`
  );
  const counts = { all: 0, flagged: 0, no_price: 0, failed: 0 } as Record<'all' | ProblemKind, number>;
  for (const r of countRows) { counts[r.last_status as ProblemKind] = Number(r.n); counts.all += Number(r.n); }
  return { entries, counts };
}

async function entryFor(serial: string, deps: Pick<EngineDeps, 'query'>): Promise<ReviewEntry | null> {
  const { rows } = await deps.query(reviewSql('AND i.serial_number = $1'), [serial]);
  return rows[0] ? mapEntry(rows[0]) : null;
}

class ReviewError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

/** Asks the suppliers about one item now, and keeps their answers as its latest result. Changes no price. */
export async function recheckItem(serial: string, decidedBy: string, deps: EngineDeps = defaultEngineDeps): Promise<ReviewEntry | null> {
  const settings = await deps.readSettings();
  const [item] = await deps.selectItems('selected', { settings, serialNumbers: [serial] });
  if (!item) throw new ReviewError(404, 'Item not found.');
  if (!item.partNumber) throw new ReviewError(400, 'The item has no part number to look up. Add one first.');
  const fx = await deps.readFx();
  if (!fx.usdToZar) throw new ReviewError(400, 'No USD to ZAR exchange rate is stored. Refresh the exchange rate first.');

  let status: string;
  let reason: string | null = null;
  let answers: QuoteAnswer[] | null = null;
  let offer: { provider: string; zar: number; usd: number; matchedPart: string | null; nativePrice: number; currency: string } | null = null;
  try {
    const quote = await deps.quote(item.partNumber, settings.qty, RECHECK_MAX_AGE_MS, item.lcscCode ?? null);
    answers = summariseQuote(quote, fx);
    const choice = chooseOffer(quote, fx, settings.suspiciousAboveUsd);
    if (choice.kind === 'no_price') {
      status = 'no_price';
      reason = choice.reason;
    } else {
      offer = choice.offer;
      status = choice.kind === 'flagged' ? 'flagged' : 'offer';
      reason = choice.kind === 'flagged' ? choice.reason : null;
    }
  } catch (err: any) {
    status = 'failed';
    reason = `Supplier lookup failed: ${err?.message || err}`;
  }
  // Kept as a preview (dry_run, no run): the review shows it; nothing else counts it.
  await deps.query(
    `INSERT INTO bulk_price_history (run_id, serial_number, part_number, source, dry_run, status,
       old_price_zar, new_price_zar, old_price_usd, new_price_usd, provider, matched_part, native_price, native_currency, qty, error, offers, decided_by)
     VALUES (NULL, $1, $2, 'manual', TRUE, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15)`,
    [serial, item.partNumber, status, item.bulkPriceZar, offer?.zar ?? null, item.bulkPriceUsd, offer?.usd ?? null,
      offer?.provider ?? null, offer?.matchedPart ?? null, offer?.nativePrice ?? null, offer?.currency ?? null, settings.qty, reason,
      answers ? JSON.stringify(answers) : null, decidedBy]
  );
  await deps.notifyChanged(['bulk_pricing']).catch(() => {});
  return entryFor(serial, deps);
}

export type Decision =
  | { kind: 'approved'; historyId: number; provider: string }
  | { kind: 'manual'; zar: number }
  | { kind: 'rejected'; note?: string };

/** Applies a person's decision on an item's bulk price, in one transaction. */
export async function decide(serial: string, decision: Decision, decidedBy: string, deps: EngineDeps = defaultEngineDeps) {
  const settings = await deps.readSettings();
  let client: Pick<PoolClient, 'query' | 'release'> | null = null;
  try {
    client = await deps.connect();
    await client.query('BEGIN');
    const { rows: [current] } = await client.query(
      `SELECT bulk_price_zar, bulk_price_usd FROM inventory WHERE serial_number = $1 AND deleted IS NOT TRUE FOR UPDATE`,
      [serial]
    );
    if (!current) throw new ReviewError(404, 'Item not found.');
    const { rows: [pnRow] } = await client.query(`SELECT ${PART_NUMBER_SQL} AS part_number FROM inventory i WHERE i.serial_number = $1`, [serial]);
    const oldZar = priceOrNull(current.bulk_price_zar);
    const oldUsd = priceOrNull(current.bulk_price_usd);

    let newZar = oldZar;
    let newUsd = oldUsd;
    let provider: string | null = null;
    let matchedPart: string | null = null;
    let nativePrice: number | null = null;
    let nativeCurrency: string | null = null;
    let note: string | null = null;

    if (decision.kind === 'approved') {
      // Only a supplier's answer from the item's latest result: never a stale one.
      const { rows: [latest] } = await client.query(
        `SELECT id, offers FROM bulk_price_history WHERE serial_number = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
        [serial]
      );
      if (!latest || Number(latest.id) !== decision.historyId) throw new ReviewError(409, 'There is a newer result for this item. Reload it and check again.');
      const answer = (Array.isArray(latest.offers) ? latest.offers as QuoteAnswer[] : []).find((a) => a.provider === decision.provider);
      if (!answer || answer.zar === null || answer.usd === null) throw new ReviewError(400, 'That supplier has no usable price in this result.');
      newZar = answer.zar;
      newUsd = answer.usd;
      provider = answer.provider;
      matchedPart = answer.matchedPart;
      nativePrice = answer.nativePrice;
      nativeCurrency = answer.currency;
      note = `Approved ${answer.provider}'s price${answer.matchedPart ? ` for ${answer.matchedPart}` : ''}.`;
    } else if (decision.kind === 'manual') {
      const fx = await deps.readFx();
      if (!fx.usdToZar) throw new ReviewError(400, 'No USD to ZAR exchange rate is stored. Refresh the exchange rate first.');
      newZar = Number(decision.zar.toFixed(4));
      newUsd = Number((decision.zar / fx.usdToZar).toFixed(4));
      provider = 'manual';
      note = 'Set by hand.';
    } else {
      note = decision.note?.trim() ? `Kept the current price: ${decision.note.trim()}` : 'Kept the current price.';
    }

    const changed = decision.kind !== 'rejected' && (newZar !== oldZar || newUsd !== oldUsd);
    if (changed) {
      await client.query(`UPDATE inventory SET bulk_price_zar = $1, bulk_price_usd = $2 WHERE serial_number = $3`, [String(newZar), String(newUsd), serial]);
    }
    await client.query(
      `INSERT INTO bulk_price_history (run_id, serial_number, part_number, source, dry_run, status,
         old_price_zar, new_price_zar, old_price_usd, new_price_usd, provider, matched_part, native_price, native_currency, qty, error, decided_by)
       VALUES (NULL, $1, $2, 'manual', FALSE, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [serial, pnRow?.part_number ?? null, decision.kind, oldZar, newZar, oldUsd, newUsd, provider, matchedPart, nativePrice, nativeCurrency, settings.qty, note, decidedBy]
    );
    // A decision is the item's latest bulk pricing: out of the problem list,
    // and next due once the re-price interval has passed.
    await client.query(
      `INSERT INTO bulk_price_status (serial_number, last_attempt_at, last_success_at, last_run_id, last_source, last_status,
         last_old_price_zar, last_new_price_zar, last_error)
       VALUES ($1, now(), now(), NULL, 'manual', $2, $3, $4, NULL)
       ON CONFLICT (serial_number) DO UPDATE SET
         last_attempt_at = now(), last_success_at = now(), last_run_id = NULL, last_source = 'manual', last_status = $2,
         last_old_price_zar = CASE WHEN $5::boolean THEN $3 ELSE bulk_price_status.last_old_price_zar END,
         last_new_price_zar = CASE WHEN $5::boolean THEN $4 ELSE bulk_price_status.last_new_price_zar END,
         last_error = NULL`,
      [serial, decision.kind, oldZar, newZar, changed]
    );
    await client.query('COMMIT');
    await deps.notifyChanged(changed ? ['bulk_pricing', 'inventory'] : ['bulk_pricing']).catch(() => {});
    return { serialNumber: serial, decision: decision.kind, changed, oldPriceZar: oldZar, newPriceZar: newZar, oldPriceUsd: oldUsd, newPriceUsd: newUsd };
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client?.release();
  }
}

/** Leaves an item out of bulk pricing (or puts it back), and records who did. */
export async function setExcluded(serial: string, excluded: boolean, decidedBy: string, deps: Pick<EngineDeps, 'query' | 'notifyChanged'> = defaultEngineDeps) {
  const { rows: [item] } = await deps.query(
    `SELECT i.bulk_price_zar, i.bulk_price_usd, ${PART_NUMBER_SQL} AS part_number FROM inventory i WHERE i.serial_number = $1 AND i.deleted IS NOT TRUE`,
    [serial]
  );
  if (!item) throw new ReviewError(404, 'Item not found.');
  await deps.query(
    `INSERT INTO bulk_price_status (serial_number, excluded, excluded_by, excluded_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (serial_number) DO UPDATE SET excluded = EXCLUDED.excluded, excluded_by = EXCLUDED.excluded_by, excluded_at = EXCLUDED.excluded_at`,
    [serial, excluded, decidedBy]
  );
  const price = priceOrNull(item.bulk_price_zar);
  const usd = priceOrNull(item.bulk_price_usd);
  await deps.query(
    `INSERT INTO bulk_price_history (run_id, serial_number, part_number, source, dry_run, status,
       old_price_zar, new_price_zar, old_price_usd, new_price_usd, error, decided_by)
     VALUES (NULL, $1, $2, 'manual', FALSE, $3, $4, $4, $5, $5, $6, $7)`,
    [serial, item.part_number ?? null, excluded ? 'excluded' : 'included', price, usd,
      excluded ? 'Left out of bulk pricing.' : 'Put back into bulk pricing.', decidedBy]
  );
  await deps.notifyChanged(['bulk_pricing']).catch(() => {});
  return { serialNumber: serial, excluded };
}

export function registerBulkPricingReviewRoutes(app: Express, deps: EngineDeps = defaultEngineDeps): void {
  const fail = (res: any, err: any) => {
    if (err instanceof ReviewError) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: err?.message || String(err) });
  };
  const serialOf = (req: any) => String(req.params.serial ?? '').trim();
  const who = (req: any) => req.user?.email || 'unknown';

  app.get('/api/pricing/bulk-review', async (req, res) => {
    const kind = req.query.kind ? String(req.query.kind) : null;
    if (kind && !PROBLEM_KINDS.includes(kind as ProblemKind)) {
      return res.status(400).json({ error: `kind must be one of: ${PROBLEM_KINDS.join(', ')}.` });
    }
    try {
      res.json(await listProblems(kind as ProblemKind | null, deps));
    } catch (err) { fail(res, err); }
  });

  const gate = requirePermission('inventory.update');

  app.post('/api/pricing/bulk-review/:serial/recheck', gate, async (req, res) => {
    try {
      res.json({ entry: await recheckItem(serialOf(req), who(req), deps) });
    } catch (err) { fail(res, err); }
  });

  app.post('/api/pricing/bulk-review/:serial/approve', gate, async (req: any, res) => {
    const historyId = Number(req.body?.historyId);
    const provider = typeof req.body?.provider === 'string' ? req.body.provider : '';
    if (!Number.isInteger(historyId) || historyId <= 0 || !provider) {
      return res.status(400).json({ error: 'Say which result (historyId) and which supplier (provider) to approve.' });
    }
    try {
      res.json(await decide(serialOf(req), { kind: 'approved', historyId, provider }, who(req), deps));
    } catch (err) { fail(res, err); }
  });

  app.post('/api/pricing/bulk-review/:serial/reject', gate, async (req: any, res) => {
    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : undefined;
    try {
      res.json(await decide(serialOf(req), { kind: 'rejected', note }, who(req), deps));
    } catch (err) { fail(res, err); }
  });

  app.post('/api/pricing/bulk-review/:serial/price', gate, async (req: any, res) => {
    const zar = Number(req.body?.zar);
    if (!Number.isFinite(zar) || zar <= 0 || zar > 10_000_000) {
      return res.status(400).json({ error: 'The price must be a number of rand above 0.' });
    }
    try {
      res.json(await decide(serialOf(req), { kind: 'manual', zar }, who(req), deps));
    } catch (err) { fail(res, err); }
  });

  app.post('/api/pricing/bulk-review/:serial/exclude', gate, async (req: any, res) => {
    if (typeof req.body?.excluded !== 'boolean') return res.status(400).json({ error: 'excluded must be true or false.' });
    try {
      res.json(await setExcluded(serialOf(req), req.body.excluded, who(req), deps));
    } catch (err) { fail(res, err); }
  });
}
