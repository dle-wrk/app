// In-memory stand-in for the database, for the bulk pricing tests
// (bulkPricing.test.ts, bulkPricingRoutes.test.ts). Not used by the app.
//
// It understands exactly the statements the engine and routes send, by their
// text: BEGIN/COMMIT/ROLLBACK as snapshots, the one-running-run unique index
// (INSERT fails with 23505), the stale-run takeover, and so on. Any other SQL
// throws, so nothing can quietly write somewhere unexpected. The log's
// status-list queries are too involved to imitate; tests give their rows in
// `canned` (and the real SQL is checked against Postgres separately).
// Timestamps are numbers (ms) on a clock the test controls: `state.now`.

export const DAY = 24 * 60 * 60 * 1000;
export const NOW = new Date('2026-10-06T08:00:00Z').getTime();

export type Row = Record<string, any>;

const STALE_MS = 10 * 60_000;

export function fakeDb(now: number = NOW) {
  const state = {
    now,
    inventory: new Map<string, Row>(),
    runs: [] as Row[],
    history: [] as Row[],
    status: new Map<string, Row>(),
    settings: new Map<string, string>(),
    statements: [] as string[],
    params: [] as any[][],
    canned: [] as Array<{ test: RegExp; rows: Row[] }>,
    failOn: null as RegExp | null,
    failTimes: 0,
    nextHistoryId: 1,
    snapshot: null as null | { inventory: Map<string, Row>; history: Row[]; status: Map<string, Row> },
  };
  const copyMap = (m: Map<string, Row>) => new Map([...m].map(([k, v]) => [k, { ...v }]));
  const result = (rows: Row[] = [], rowCount = rows.length) => ({ rows, rowCount });
  const runRow = (r: Row) => ({ ...r, stale: r.status === 'running' && r.heartbeat_at < state.now - STALE_MS });
  const newestFirst = (a: Row, b: Row) => b.started_at - a.started_at || b.id - a.id;
  const RUN_SELECT = /^SELECT id, trigger, scope, dry_run, qty, status, stop_requested, requested_by, started_at, heartbeat_at, finished_at, total, checked, updated, unchanged, flagged, no_price, skipped, failed, error, note, \(status = 'running' AND heartbeat_at < now\(\) - make_interval\(mins => 10\)\) AS stale FROM bulk_pricing_runs /;

  async function run(text: string, p: any[] = []) {
    const sql = text.replace(/\s+/g, ' ').trim();
    state.statements.push(sql);
    state.params.push(p);
    if (state.failOn && state.failTimes > 0 && state.failOn.test(sql)) {
      state.failTimes -= 1;
      throw new Error('connection reset by peer');
    }
    const now = state.now;
    const canned = state.canned.find((c) => c.test.test(sql));
    if (canned) return result(canned.rows);

    if (sql === 'BEGIN') { state.snapshot = { inventory: copyMap(state.inventory), history: state.history.map((r) => ({ ...r })), status: copyMap(state.status) }; return result(); }
    if (sql === 'COMMIT') { state.snapshot = null; return result(); }
    if (sql === 'ROLLBACK') {
      if (state.snapshot) Object.assign(state, state.snapshot);
      state.snapshot = null;
      return result();
    }

    // --- runs -------------------------------------------------------------
    if (sql.startsWith("UPDATE bulk_pricing_runs SET status = 'interrupted'")) {
      const stale = state.runs.filter((r) => r.status === 'running' && r.heartbeat_at < now - p[0] * 60_000);
      for (const r of stale) Object.assign(r, { status: 'interrupted', finished_at: now, error: 'The server stopped before this run finished.' });
      return result([], stale.length);
    }
    if (sql.startsWith('INSERT INTO bulk_pricing_runs')) {
      if (state.runs.some((r) => r.status === 'running')) throw Object.assign(new Error('duplicate key value violates unique constraint "bulk_pricing_one_running"'), { code: '23505' });
      const row = { id: state.runs.length + 1, trigger: p[0], scope: p[1], dry_run: p[2], qty: p[3], requested_by: p[4], status: 'running', stop_requested: false,
        started_at: now, heartbeat_at: now, finished_at: null, total: 0, checked: 0, updated: 0, unchanged: 0, flagged: 0, no_price: 0, skipped: 0, failed: 0, error: null, note: null };
      state.runs.push(row);
      return result([{ id: row.id }]);
    }
    if (sql === "SELECT id, started_at FROM bulk_pricing_runs WHERE status = 'running' LIMIT 1") {
      return result(state.runs.filter((r) => r.status === 'running').slice(0, 1).map((r) => ({ id: r.id, started_at: new Date(r.started_at).toISOString() })));
    }
    if (sql === "UPDATE bulk_pricing_runs SET heartbeat_at = now() WHERE id = $1 AND status = 'running'") {
      const r = state.runs.find((x) => x.id === p[0] && x.status === 'running');
      if (r) { r.heartbeat_at = now; r.beats = (r.beats ?? 0) + 1; }
      return result([], r ? 1 : 0);
    }
    if (sql.startsWith('UPDATE bulk_pricing_runs SET heartbeat_at = now(), total = $2') && sql.endsWith('WHERE id = $1 RETURNING stop_requested')) {
      const r = state.runs.find((x) => x.id === p[0])!;
      Object.assign(r, { heartbeat_at: now, total: p[1], checked: p[2], updated: p[3], unchanged: p[4], flagged: p[5], no_price: p[6], skipped: p[7], failed: p[8] });
      return result([{ stop_requested: r.stop_requested }]);
    }
    if (sql === "UPDATE bulk_pricing_runs SET stop_requested = TRUE WHERE id = $1 AND status = 'running'") {
      const r = state.runs.find((x) => x.id === p[0] && x.status === 'running');
      if (r) r.stop_requested = true;
      return result([], r ? 1 : 0);
    }
    if (sql.startsWith('UPDATE bulk_pricing_runs SET status = $2')) {
      const r = state.runs.find((x) => x.id === p[0])!;
      Object.assign(r, { status: p[1], finished_at: now, heartbeat_at: now, total: p[2], checked: p[3], updated: p[4], unchanged: p[5], flagged: p[6], no_price: p[7], skipped: p[8], failed: p[9], error: p[10], note: p[11] });
      return result([], 1);
    }
    if (sql.startsWith("SELECT 1 FROM bulk_pricing_runs WHERE trigger = 'auto'")) {
      return result(state.runs.filter((r) => r.trigger === 'auto' && r.started_at > now - p[0] * 3_600_000).slice(0, 1).map(() => ({ '?column?': 1 })));
    }
    if (RUN_SELECT.test(sql)) {
      const rest = sql.replace(RUN_SELECT, '');
      if (rest === 'WHERE id = $1') return result(state.runs.filter((r) => r.id === p[0]).map(runRow));
      if (rest === 'ORDER BY started_at DESC, id DESC LIMIT $1') return result([...state.runs].sort(newestFirst).slice(0, p[0]).map(runRow));
    }
    if (sql.startsWith('(SELECT id, trigger,') && sql.includes(') UNION ALL (')) {
      const running = state.runs.filter((r) => r.status === 'running').sort(newestFirst).slice(0, 1);
      const auto = state.runs.filter((r) => r.trigger === 'auto').sort(newestFirst).slice(0, 1);
      return result([...running, ...auto].map(runRow));
    }

    // --- history ----------------------------------------------------------
    if (sql.startsWith('DELETE FROM bulk_price_history WHERE created_at < now()')) {
      const keep = state.history.filter((h) => h.created_at >= now - p[0] * DAY);
      const n = state.history.length - keep.length;
      state.history = keep;
      return result([], n);
    }
    if (sql.startsWith('INSERT INTO bulk_price_history')) {
      const cols = ['run_id', 'serial_number', 'part_number', 'source', 'dry_run', 'status', 'old_price_zar', 'new_price_zar', 'old_price_usd', 'new_price_usd',
        'provider', 'matched_part', 'native_price', 'native_currency', 'qty', 'error'];
      state.history.push({ id: state.nextHistoryId++, ...Object.fromEntries(cols.map((c, i) => [c, p[i]])), created_at: now });
      return result([], 1);
    }
    if (sql.startsWith('SELECT h.id, h.run_id, h.serial_number, i.name,') && sql.endsWith('WHERE h.run_id = $1 ORDER BY h.id')) {
      return result(state.history.filter((h) => h.run_id === p[0]).sort((a, b) => a.id - b.id)
        .map((h) => ({ ...h, name: state.inventory.get(h.serial_number)?.name ?? null })));
    }
    if (sql.startsWith('SELECT h.id, h.run_id, h.serial_number, h.part_number,') && sql.endsWith('WHERE h.serial_number = $1 AND h.dry_run = FALSE ORDER BY h.created_at DESC, h.id DESC LIMIT 200')) {
      return result(state.history.filter((h) => h.serial_number === p[0] && h.dry_run === false)
        .sort((a, b) => b.created_at - a.created_at || b.id - a.id).slice(0, 200));
    }

    // --- items and their status -------------------------------------------
    if (sql === 'SELECT bulk_price_zar, bulk_price_usd FROM inventory WHERE serial_number = $1 FOR UPDATE') {
      const r = state.inventory.get(p[0]);
      return result(r ? [{ bulk_price_zar: r.bulk_price_zar, bulk_price_usd: r.bulk_price_usd }] : []);
    }
    if (sql === 'UPDATE inventory SET bulk_price_zar = $1, bulk_price_usd = $2 WHERE serial_number = $3') {
      const r = state.inventory.get(p[2])!;
      Object.assign(r, { bulk_price_zar: p[0], bulk_price_usd: p[1] });
      return result([], 1);
    }
    if (sql.startsWith('INSERT INTO bulk_price_status')) {
      const [sn, succeeded, runId, source, status, oldZar, newZar, error] = p;
      const prev = state.status.get(sn);
      state.status.set(sn, {
        last_attempt_at: now,
        last_success_at: succeeded ? now : prev?.last_success_at ?? null,
        last_run_id: runId, last_source: source, last_status: status,
        last_old_price_zar: succeeded ? oldZar : prev?.last_old_price_zar ?? null,
        last_new_price_zar: succeeded ? newZar : prev?.last_new_price_zar ?? null,
        last_error: error,
      });
      return result([], 1);
    }

    // --- settings ---------------------------------------------------------
    if (sql === 'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value') {
      state.settings.set(p[0], p[1]);
      return result([], 1);
    }

    throw new Error(`unexpected SQL in test: ${sql}`);
  }
  return { state, run };
}

export type FakeDb = ReturnType<typeof fakeDb>;
