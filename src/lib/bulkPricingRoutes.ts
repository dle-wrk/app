// Bulk pricing API. The engine (runs, pricing, history, the daily job) is
// ./bulkPricing.ts; this file is the HTTP surface and the read side of the log.
//
//   POST /api/pricing/bulk-runs                     start a run: 202 {runId}, 409 while one is running (inventory.update)
//   GET  /api/pricing/bulk-runs                     recent runs, newest first
//   GET  /api/pricing/bulk-runs/:id                 one run: counts, grouped reasons, per-item results
//   POST /api/pricing/bulk-runs/:id/stop            ask a running run to stop after the item in hand (inventory.update)
//   GET  /api/pricing/bulk-status                   the log: every item's last bulk pricing and next due date
//   GET  /api/pricing/bulk-status/:serial/history   one item's price history (within the retention period)
//   GET  /api/pricing/bulk-settings                 settings, with any warnings
//   PUT  /api/pricing/bulk-settings                 change settings (admins)
//
// A run is started here and carries on after the response; the page follows
// it through GET /bulk-runs/:id. All SQL goes through deps.query so the
// routes can be tested against a stand-in database.

import type { Express } from 'express';
import { requireAdmin, requirePermission } from './authRoutes';
import {
  DEFAULT_SETTINGS, DUE_SQL, LCSC_CODE_SQL, PART_NUMBER_SQL, RUN_SCOPES, STALE_RUN_MINUTES, RunInProgressError,
  beginRun, defaultEngineDeps, groupReasons, missingPriceSql, nextAutoRunAt, nextDueAt, parseSettings, priceOrNull,
  processRun, requestStop, saveSettings,
  type EngineDeps, type ItemStatus, type RunOptions, type RunScope,
} from './bulkPricing';

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(v as any).toISOString());
const int = (v: unknown): number => Number(v) || 0;

const RUN_COLUMNS = `id, trigger, scope, dry_run, qty, status, stop_requested, requested_by, started_at, heartbeat_at, finished_at,
  total, checked, updated, unchanged, flagged, no_price, skipped, failed, error, note,
  (status = 'running' AND heartbeat_at < now() - make_interval(mins => ${STALE_RUN_MINUTES})) AS stale`;

export function mapRun(r: any) {
  return {
    id: int(r.id),
    trigger: r.trigger as 'manual' | 'auto',
    scope: r.scope as RunScope,
    dryRun: r.dry_run === true,
    qty: int(r.qty),
    status: r.status as string,
    stopRequested: r.stop_requested === true,
    /** Running, but no heartbeat for STALE_RUN_MINUTES: its server most likely stopped. */
    stale: r.stale === true,
    requestedBy: r.requested_by ?? null,
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    total: int(r.total),
    checked: int(r.checked),
    updated: int(r.updated),
    unchanged: int(r.unchanged),
    flagged: int(r.flagged),
    noPrice: int(r.no_price),
    skipped: int(r.skipped),
    failed: int(r.failed),
    error: r.error ?? null,
    note: r.note ?? null,
  };
}

function mapHistory(r: any) {
  return {
    id: int(r.id),
    runId: r.run_id === null || r.run_id === undefined ? null : int(r.run_id),
    serialNumber: r.serial_number,
    name: r.name ?? null,
    partNumber: r.part_number ?? null,
    source: r.source,
    dryRun: r.dry_run === true,
    status: r.status as ItemStatus,
    oldPriceZar: priceOrNull(r.old_price_zar),
    newPriceZar: priceOrNull(r.new_price_zar),
    oldPriceUsd: priceOrNull(r.old_price_usd),
    newPriceUsd: priceOrNull(r.new_price_usd),
    provider: r.provider ?? null,
    matchedPart: r.matched_part ?? null,
    nativePrice: priceOrNull(r.native_price),
    nativeCurrency: r.native_currency ?? null,
    qty: r.qty === null || r.qty === undefined ? null : int(r.qty),
    reason: r.error ?? null,
    /** Who approved, rejected, set or re-checked it (review decisions only). */
    decidedBy: r.decided_by ?? null,
    at: iso(r.created_at),
  };
}

// The log's filters and sort orders. Every column is from the `s` row set
// built in STATUS_BASE (one row per item).
const PROBLEM_STATUSES = `('failed', 'no_price', 'flagged')`;
export const STATUS_FILTERS: Record<string, string> = {
  all: 'TRUE',
  // An excluded item is left out of bulk pricing on purpose: not due, not a problem.
  due: `s.part_number IS NOT NULL AND s.excluded IS NOT TRUE AND ${DUE_SQL}`,
  problems: `s.excluded IS NOT TRUE AND s.last_status IN ${PROBLEM_STATUSES}`,
  never: `s.part_number IS NOT NULL AND s.excluded IS NOT TRUE AND s.last_success_at IS NULL`,
  missing: `s.part_number IS NOT NULL AND s.excluded IS NOT TRUE AND ${missingPriceSql('s.bulk_price_zar')}`,
  no_part_number: `s.part_number IS NULL`,
  excluded: `s.excluded IS TRUE`,
};
export const STATUS_SORTS: Record<string, string> = {
  oldest: 's.last_success_at ASC NULLS FIRST, s.serial_number',
  recent: 's.last_attempt_at DESC NULLS LAST, s.serial_number',
  failed: `(CASE WHEN s.last_status IN ${PROBLEM_STATUSES} THEN 0 ELSE 1 END), s.last_attempt_at DESC NULLS LAST, s.serial_number`,
  code: 's.serial_number',
};

// $1 and $2 are the due rule's threshold and retry days (see DUE_SQL).
const STATUS_BASE = `WITH s AS (
  SELECT i.serial_number, i.name, ${PART_NUMBER_SQL} AS part_number, ${LCSC_CODE_SQL} AS lcsc_code, i.bulk_price_zar, i.bulk_price_usd,
         st.last_attempt_at, st.last_success_at, st.last_run_id, st.last_source, st.last_status,
         st.last_old_price_zar, st.last_new_price_zar, st.last_error, st.excluded, st.excluded_by
    FROM inventory i LEFT JOIN bulk_price_status st ON st.serial_number = i.serial_number
   WHERE i.deleted IS NOT TRUE
)`;

export function registerBulkPricingRoutes(app: Express, deps: EngineDeps = defaultEngineDeps): void {
  // Starting and stopping runs changes prices: roles that may change inventory.
  app.post('/api/pricing/bulk-runs', requirePermission('inventory.update'), async (req: any, res) => {
    const body = req.body ?? {};
    const scope = body.scope as RunScope;
    if (!RUN_SCOPES.includes(scope)) {
      return res.status(400).json({ error: `scope must be one of: ${RUN_SCOPES.join(', ')}.` });
    }
    if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') {
      return res.status(400).json({ error: 'dryRun must be true or false.' });
    }
    let serialNumbers: string[] | undefined;
    if (scope === 'selected') {
      const list = body.serialNumbers;
      if (!Array.isArray(list) || list.length === 0 || list.some((s: unknown) => typeof s !== 'string' || !s.trim())) {
        return res.status(400).json({ error: 'Choose at least one item: serialNumbers must be a list of stock codes.' });
      }
      serialNumbers = [...new Set<string>(list.map((s: string) => s.trim()))];
      if (serialNumbers.length > 5000) return res.status(400).json({ error: 'At most 5000 items per run.' });
    }

    const options: RunOptions = {
      trigger: 'manual',
      scope,
      dryRun: body.dryRun === true,
      serialNumbers,
      requestedBy: req.user?.email ?? null,
    };
    try {
      const settings = await deps.readSettings();
      const runId = await beginRun(options, settings, deps);
      res.status(202).json({ runId });
      // The run carries on after the response. processRun records its own
      // outcome and never throws; the catch is belt and braces.
      processRun(runId, options, deps)
        .then((s) => console.log(`[BULK PRICING] run #${runId} (${s.scope}${s.dryRun ? ', preview' : ''}, by ${options.requestedBy ?? 'unknown'}) ${s.status}: `
          + `${s.checked}/${s.total} checked, ${s.updated} updated, ${s.unchanged} unchanged, ${s.flagged} held back, ${s.noPrice} without a price, ${s.skipped} skipped, ${s.failed} failed.`))
        .catch((err) => console.error(`[BULK PRICING] run #${runId} crashed:`, err?.message || err));
    } catch (err: any) {
      if (err instanceof RunInProgressError) return res.status(409).json({ error: err.message, runId: err.runId });
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.get('/api/pricing/bulk-runs', async (req, res) => {
    const limit = Math.max(1, Math.min(100, parseInt(String(req.query.limit ?? '20'), 10) || 20));
    try {
      const { rows } = await deps.query(`SELECT ${RUN_COLUMNS} FROM bulk_pricing_runs ORDER BY started_at DESC, id DESC LIMIT $1`, [limit]);
      res.json({ runs: rows.map(mapRun) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/pricing/bulk-runs/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid run id.' });
    try {
      const { rows } = await deps.query(`SELECT ${RUN_COLUMNS} FROM bulk_pricing_runs WHERE id = $1`, [id]);
      if (!rows.length) return res.status(404).json({ error: 'Run not found.' });
      // Per-item results while their history is kept (historyRetentionDays).
      const { rows: history } = await deps.query(
        `SELECT h.id, h.run_id, h.serial_number, i.name, h.part_number, h.source, h.dry_run, h.status,
                h.old_price_zar, h.new_price_zar, h.old_price_usd, h.new_price_usd, h.provider, h.matched_part,
                h.native_price, h.native_currency, h.qty, h.error, h.created_at
           FROM bulk_price_history h LEFT JOIN inventory i ON i.serial_number = h.serial_number
          WHERE h.run_id = $1
          ORDER BY h.id`,
        [id]
      );
      const items = history.map(mapHistory);
      res.json({ run: mapRun(rows[0]), reasons: groupReasons(items), items });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/pricing/bulk-runs/:id/stop', requirePermission('inventory.update'), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid run id.' });
    try {
      if (!(await requestStop(id, deps))) return res.status(409).json({ error: 'That run is not in progress.' });
      res.json({ ok: true, message: 'The run will stop after the item it is pricing now.' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/pricing/bulk-status', async (req, res) => {
    const filter = String(req.query.filter ?? 'all');
    const sort = String(req.query.sort ?? 'oldest');
    if (!(filter in STATUS_FILTERS)) return res.status(400).json({ error: `filter must be one of: ${Object.keys(STATUS_FILTERS).join(', ')}.` });
    if (!(sort in STATUS_SORTS)) return res.status(400).json({ error: `sort must be one of: ${Object.keys(STATUS_SORTS).join(', ')}.` });
    const limit = Math.max(1, Math.min(500, parseInt(String(req.query.limit ?? '100'), 10) || 100));
    const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);
    const search = String(req.query.search ?? '').trim().slice(0, 100);

    try {
      const settings = await deps.readSettings();
      const dueParams = [settings.autoThresholdDays, settings.retryFailedAfterDays];
      const params: any[] = [...dueParams];
      let where = STATUS_FILTERS[filter];
      if (search) {
        params.push(`%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
        const p = `$${params.length}`;
        where += ` AND (s.serial_number ILIKE ${p} OR s.name ILIKE ${p} OR s.part_number ILIKE ${p} OR s.lcsc_code ILIKE ${p})`;
      }
      params.push(limit, offset);
      // `due` is computed by the same SQL as the Due filter, so the flag on
      // each row always agrees with it (and $1/$2 are always used).
      const { rows } = await deps.query(
        `${STATUS_BASE}
         SELECT s.*, (${STATUS_FILTERS.due}) AS due, COUNT(*) OVER () AS total_count FROM s
          WHERE ${where}
          ORDER BY ${STATUS_SORTS[sort]}
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );
      const { rows: countRows } = await deps.query(
        `${STATUS_BASE}
         SELECT COUNT(*) AS all_items,
                COUNT(*) FILTER (WHERE ${STATUS_FILTERS.due}) AS due,
                COUNT(*) FILTER (WHERE ${STATUS_FILTERS.problems}) AS problems,
                COUNT(*) FILTER (WHERE ${STATUS_FILTERS.never}) AS never,
                COUNT(*) FILTER (WHERE ${STATUS_FILTERS.missing}) AS missing,
                COUNT(*) FILTER (WHERE ${STATUS_FILTERS.no_part_number}) AS no_part_number,
                COUNT(*) FILTER (WHERE ${STATUS_FILTERS.excluded}) AS excluded
           FROM s`,
        dueParams
      );
      const { rows: runRows } = await deps.query(
        `(SELECT ${RUN_COLUMNS} FROM bulk_pricing_runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1)
         UNION ALL
         (SELECT ${RUN_COLUMNS} FROM bulk_pricing_runs WHERE trigger = 'auto' ORDER BY started_at DESC LIMIT 1)`
      );

      const now = new Date();
      const items = rows.map((r) => {
        const status = { lastAttemptAt: r.last_attempt_at ?? null, lastSuccessAt: r.last_success_at ?? null };
        const due = r.due === true;
        return {
          serialNumber: r.serial_number,
          name: r.name ?? null,
          partNumber: r.part_number ?? null,
          lcscCode: r.lcsc_code ?? null,
          bulkPriceZar: priceOrNull(r.bulk_price_zar),
          bulkPriceUsd: priceOrNull(r.bulk_price_usd),
          lastAttemptAt: iso(r.last_attempt_at),
          lastSuccessAt: iso(r.last_success_at),
          lastRunId: r.last_run_id === null || r.last_run_id === undefined ? null : int(r.last_run_id),
          lastSource: r.last_source ?? null,
          lastStatus: r.last_status ?? null,
          lastOldPriceZar: priceOrNull(r.last_old_price_zar),
          lastNewPriceZar: priceOrNull(r.last_new_price_zar),
          lastError: r.last_error ?? null,
          excluded: r.excluded === true,
          excludedBy: r.excluded_by ?? null,
          due,
          /** When a priceable item that isn't due yet becomes due. */
          nextDueAt: r.part_number && !due && r.excluded !== true ? iso(nextDueAt(status, now, settings)) : null,
        };
      });
      const c = countRows[0] ?? {};
      const runs = runRows.map(mapRun);
      res.json({
        items,
        total: rows.length ? int(rows[0].total_count) : 0,
        limit,
        offset,
        counts: { all: int(c.all_items), due: int(c.due), problems: int(c.problems), never: int(c.never), missing: int(c.missing), noPartNumber: int(c.no_part_number), excluded: int(c.excluded) },
        settings,
        warnings: (() => { const p = parseSettings(settings); return 'warnings' in p ? p.warnings : []; })(),
        nextAutoRunAt: settings.autoEnabled ? nextAutoRunAt(now).toISOString() : null,
        running: runs.find((r) => r.status === 'running') ?? null,
        lastAutoRun: runs.find((r) => r.trigger === 'auto' && r.status !== 'running') ?? runs.find((r) => r.trigger === 'auto') ?? null,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/pricing/bulk-status/:serial/history', async (req, res) => {
    const serial = String(req.params.serial ?? '').trim();
    if (!serial) return res.status(400).json({ error: 'Stock code required.' });
    try {
      // Previews are left out: they changed nothing.
      const { rows } = await deps.query(
        `SELECT h.id, h.run_id, h.serial_number, h.part_number, h.source, h.dry_run, h.status,
                h.old_price_zar, h.new_price_zar, h.old_price_usd, h.new_price_usd, h.provider, h.matched_part,
                h.native_price, h.native_currency, h.qty, h.error, h.decided_by, h.created_at
           FROM bulk_price_history h
          WHERE h.serial_number = $1 AND h.dry_run = FALSE
          ORDER BY h.created_at DESC, h.id DESC
          LIMIT 200`,
        [serial]
      );
      const settings = await deps.readSettings();
      res.json({ serialNumber: serial, retentionDays: settings.historyRetentionDays, history: rows.map(mapHistory) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/pricing/bulk-settings', async (_req, res) => {
    try {
      const settings = await deps.readSettings();
      const parsed = parseSettings(settings);
      res.json({ settings, warnings: 'warnings' in parsed ? parsed.warnings : [], defaults: DEFAULT_SETTINGS });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/pricing/bulk-settings', requireAdmin, async (req, res) => {
    try {
      const current = await deps.readSettings();
      const parsed = parseSettings(req.body ?? {}, current);
      if ('error' in parsed) return res.status(400).json({ error: parsed.error });
      await saveSettings(parsed.settings, deps);
      res.json({ settings: parsed.settings, warnings: parsed.warnings });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
