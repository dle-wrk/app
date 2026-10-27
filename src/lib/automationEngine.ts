// Automation rules that run: "when <something is true>, <tell people | draft
// purchase orders>", checked every hour, day or week (or only when pressed).
//
//   automation_rules        the rule: trigger_event (what to watch), conditions
//                           ({prefix}: only stock codes starting with it),
//                           actions ({type: 'NOTIFY', to} | {type: 'DRAFT_PO'}),
//                           every ('hour' | 'day' | 'week' | null = by hand)
//   automation_rule_hits    what each rule found last time, so people are told
//                           only about what is new; a hit that clears and comes
//                           back is new again
//   automation_executions   every run, with what it found and did
//   notifications           the in-app inbox (recipient 'everyone', 'role:admin',
//                           'role:manager' or an email address)
//
// The scheduled job "automation-rules" (./scheduledJobs) runs the due rules
// hourly. Nothing is sent outside the app: no email sender is set up.

import { pool, exec } from './db';

type Db = { query: (s: string, p?: any[]) => Promise<any> };

export async function ensureAutomationEngineSchema(run: (sql: string) => Promise<void> = exec): Promise<void> {
  await run(`ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS every TEXT`);
  await run(`ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS last_run_at TIMESTAMPTZ`);
  await run(`ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS last_result JSONB`);
  await run(`CREATE TABLE IF NOT EXISTS automation_rule_hits (
    rule_id INTEGER NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
    entity_id TEXT NOT NULL,
    first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (rule_id, entity_id)
  )`);
  await run(`CREATE INDEX IF NOT EXISTS automation_executions_rule ON automation_executions (rule_id, executed_at DESC)`);
}

// ---------------------------------------------------------------------------
// The rules, without a database.

export const TRIGGERS = {
  LOW_STOCK: { label: 'An item is low on stock', items: true },
  OUT_OF_STOCK: { label: 'An item is out of stock', items: true },
  MISSING_SUPPLIER: { label: 'An item has no supplier part number', items: true },
  AUTO_PO_DUE: { label: 'A watched Auto-PO item is at its reorder point', items: true },
  PO_LATE: { label: 'A purchase order is late', items: false },
  INVOICE_OVERDUE: { label: 'An invoice is overdue', items: false },
  NCR_OVERDUE: { label: 'A non-conformance report is past its due date', items: false },
  INSPECTION_OVERDUE: { label: 'A QA inspection is past its date and not done', items: true },
} as const;
export type Trigger = keyof typeof TRIGGERS;
export const isTrigger = (t: unknown): t is Trigger => typeof t === 'string' && Object.hasOwn(TRIGGERS, t);

export const EVERY = { hour: 'Every hour', day: 'Every day', week: 'Every week' } as const;
export type Every = keyof typeof EVERY;
const PERIOD: Record<Every, number> = { hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000 };

export type Action = { type: 'NOTIFY'; to: string } | { type: 'DRAFT_PO' };

/** A rule's action, including rules saved before rules ran (CREATE_PO, SEND_ALERT, ENRICH_SUPPLIERS, …). */
export function actionOf(actions: any): Action {
  const a = typeof actions === 'string' ? (() => { try { return JSON.parse(actions); } catch { return {}; } })() : (actions ?? {});
  if (a.type === 'DRAFT_PO' || a.type === 'CREATE_PO') return { type: 'DRAFT_PO' };
  return { type: 'NOTIFY', to: recipientOf(a.to) };
}

/** Who a notification goes to: everyone, a role, or one email address. */
export function recipientOf(to: unknown): string {
  const t = String(to ?? '').trim().toLowerCase();
  if (t === 'role:admin' || t === 'role:manager') return t;
  if (/^[^\s@]+@[^\s@]+$/.test(t)) return t;
  return 'everyone';
}

/** Whether a scheduled rule is due. A little early is fine: the check runs hourly, not on the dot. */
export function isDue(every: unknown, lastRunAt: Date | string | null, now = new Date()): boolean {
  if (typeof every !== 'string' || !Object.hasOwn(PERIOD, every)) return false;
  if (!lastRunAt) return true;
  return now.getTime() - new Date(lastRunAt).getTime() >= PERIOD[every as Every] - 10 * 60_000;
}

export interface Hit { id: string; label: string; detail: string }

/** What is new since last time (to tell people about), and what has cleared. */
export function diffHits(before: Iterable<string>, now: Hit[]): { fresh: Hit[]; cleared: string[] } {
  const was = new Set(before);
  const ids = new Set(now.map((h) => h.id));
  return { fresh: now.filter((h) => !was.has(h.id)), cleared: [...was].filter((id) => !ids.has(id)) };
}

const NOUN: Record<Trigger, [string, string]> = {
  LOW_STOCK: ['item is low on stock', 'items are low on stock'],
  OUT_OF_STOCK: ['item is out of stock', 'items are out of stock'],
  MISSING_SUPPLIER: ['item has no supplier part number', 'items have no supplier part number'],
  AUTO_PO_DUE: ['watched item is at its reorder point', 'watched items are at their reorder point'],
  PO_LATE: ['purchase order is late', 'purchase orders are late'],
  INVOICE_OVERDUE: ['invoice is overdue', 'invoices are overdue'],
  NCR_OVERDUE: ['NCR is past its due date', 'NCRs are past their due date'],
  INSPECTION_OVERDUE: ['inspection is overdue', 'inspections are overdue'],
};

/** The notification for a run: the new hits, the first 15 by name. */
export function notice(ruleName: string, trigger: Trigger, fresh: Hit[], total: number): { subject: string; message: string } {
  const [one, many] = NOUN[trigger];
  const subject = `${ruleName}: ${fresh.length} ${fresh.length === 1 ? one : many}${total > fresh.length ? ` (${total} in all)` : ''}`;
  const list = fresh.slice(0, 15).map((h) => `${h.label}${h.detail ? ` (${h.detail})` : ''}`).join('; ');
  return { subject, message: `${list}${fresh.length > 15 ? `; and ${fresh.length - 15} more` : ''}.` };
}

// ---------------------------------------------------------------------------
// Finding what a trigger matches.

// An item's low stock level as the app reads it: blank or 0 means 50.
const LOW_LEVEL = `COALESCE(NULLIF(NULLIF(regexp_replace(COALESCE(low_stock_lvl, ''), '[^0-9]', '', 'g'), '')::bigint, 0), 50)`;
const ITEMS = `FROM inventory WHERE deleted IS NOT TRUE AND COALESCE(UPPER(status), 'ACTIVE') NOT IN ('DISCONTINUED', 'DO NOT USE', 'INACTIVE') AND serial_number ILIKE $1`;
const blank = (c: string) => `COALESCE(TRIM(${c}), '') = ''`;
const n = (v: unknown) => Number(v).toLocaleString('en-ZA');

export async function findHits(db: Db, trigger: Trigger, conditions: any): Promise<Hit[]> {
  const prefix = `${String(conditions?.prefix ?? '').trim().replace(/[%_\\]/g, '\\$&')}%`;
  let rows: any[] = [];
  if (trigger === 'LOW_STOCK') {
    ({ rows } = await db.query(`SELECT serial_number id, name, stock, ${LOW_LEVEL} AS low ${ITEMS} AND stock > 0 AND stock <= ${LOW_LEVEL} ORDER BY serial_number`, [prefix]));
    return rows.map((r) => ({ id: r.id, label: r.id, detail: `${n(r.stock)} left, low level ${n(r.low)}` }));
  }
  if (trigger === 'OUT_OF_STOCK') {
    ({ rows } = await db.query(`SELECT serial_number id, name ${ITEMS} AND COALESCE(stock, 0) <= 0 ORDER BY serial_number`, [prefix]));
    return rows.map((r) => ({ id: r.id, label: r.id, detail: r.name ?? '' }));
  }
  if (trigger === 'MISSING_SUPPLIER') {
    ({ rows } = await db.query(`SELECT serial_number id, name ${ITEMS} AND ${[1, 2, 3, 4, 5].map((i) => blank(`sup_pn_${i}`)).join(' AND ')} ORDER BY serial_number`, [prefix]));
    return rows.map((r) => ({ id: r.id, label: r.id, detail: r.name ?? '' }));
  }
  if (trigger === 'AUTO_PO_DUE') {
    ({ rows } = await db.query(
      `SELECT c.component_id id, i.stock, c.auto_po_threshold FROM auto_po_config c JOIN inventory i ON i.serial_number = c.component_id AND i.deleted IS NOT TRUE
        WHERE c.enabled IS NOT FALSE AND i.stock <= c.auto_po_threshold AND c.component_id ILIKE $1 ORDER BY 1`, [prefix]));
    return rows.map((r) => ({ id: r.id, label: r.id, detail: `${n(r.stock)} left, reorder point ${n(r.auto_po_threshold)}` }));
  }
  if (trigger === 'PO_LATE') {
    ({ rows } = await db.query(
      `SELECT po.id::text id, po.po_number, to_char(po.expected_date, 'YYYY-MM-DD') expected, s.name supplier
         FROM purchase_orders po LEFT JOIN suppliers s ON s.id::text = po.supplier_id::text
        WHERE po.status IN ('DRAFT', 'SENT', 'PARTIAL') AND po.expected_date < CURRENT_DATE ORDER BY po.expected_date`));
    return rows.map((r) => ({ id: r.id, label: r.po_number, detail: `${r.supplier ? `${r.supplier}, ` : ''}expected ${r.expected}` }));
  }
  if (trigger === 'NCR_OVERDUE') {
    ({ rows } = await db.query(
      `SELECT id::text id, ncr_number, component_id, to_char(due_date, 'YYYY-MM-DD') due, assigned_to FROM non_conformance_reports
        WHERE status NOT IN ('RESOLVED', 'CLOSED') AND due_date < CURRENT_DATE ORDER BY due_date`));
    return rows.map((r) => ({ id: r.id, label: r.ncr_number, detail: `${r.component_id}, due ${r.due}${r.assigned_to ? `, ${r.assigned_to}` : ''}` }));
  }
  if (trigger === 'INSPECTION_OVERDUE') {
    ({ rows } = await db.query(
      `SELECT id::text id, component_id, inspection_type, to_char(scheduled_date, 'YYYY-MM-DD') due FROM qa_inspections
        WHERE status IN ('SCHEDULED', 'IN_PROGRESS') AND scheduled_date < CURRENT_DATE AND component_id ILIKE $1 ORDER BY scheduled_date`, [prefix]));
    return rows.map((r) => ({ id: r.id, label: r.component_id, detail: `${String(r.inspection_type).toLowerCase().replace('_', '-')} inspection, due ${r.due}` }));
  }
  ({ rows } = await db.query(
    `SELECT i.id::text id, i.invoice_number, to_char(i.due_date, 'YYYY-MM-DD') due, i.balance_due, i.currency, c.client_name
       FROM invoices i LEFT JOIN clients c ON c.id::text = i.client_id::text
      WHERE i.status NOT IN ('PAID', 'VOID', 'DRAFT') AND i.due_date < CURRENT_DATE AND COALESCE(i.balance_due, 0) > 0 ORDER BY i.due_date`));
  return rows.map((r) => ({ id: r.id, label: r.invoice_number, detail: `${r.client_name ? `${r.client_name}, ` : ''}${r.currency ?? ''} ${Number(r.balance_due).toFixed(2)} due ${r.due}`.trim() }));
}

// ---------------------------------------------------------------------------
// Running a rule.

export interface RunResult { total: number; fresh: number; cleared: number; notified: boolean; drafted: string[]; hits: Hit[]; freshHits: Hit[]; preview: boolean }

/**
 * Runs one rule: finds what it matches, tells people about what is new (or
 * drafts purchase orders), and records it. `preview` finds without changing
 * anything. `draftPos` is the Auto-PO check (./autoPoRoutes), passed in.
 */
export async function runRule(ruleId: number, by: string, opts: { preview?: boolean; draftPos?: (who: string) => Promise<string[]> } = {}): Promise<RunResult> {
  const started = Date.now();
  const client = await pool.connect();
  let result: RunResult | null = null;
  try {
    const { rows: [rule] } = await client.query(`SELECT * FROM automation_rules WHERE id = $1`, [ruleId]);
    if (!rule) throw Object.assign(new Error('Rule not found.'), { status: 404 });
    if (!isTrigger(rule.trigger_event)) throw Object.assign(new Error(`This rule watches "${rule.trigger_event}", which isn't something rules can watch yet. Edit it and choose what to watch.`), { status: 400 });
    const action = actionOf(rule.actions);
    const hits = await findHits(client, rule.trigger_event, rule.conditions);
    const { rows: before } = await client.query(`SELECT entity_id FROM automation_rule_hits WHERE rule_id = $1`, [ruleId]);
    const { fresh, cleared } = diffHits(before.map((r: any) => r.entity_id), hits);
    result = { total: hits.length, fresh: fresh.length, cleared: cleared.length, notified: false, drafted: [], hits: hits.slice(0, 200), freshHits: fresh.slice(0, 200), preview: !!opts.preview };
    if (opts.preview) return result;

    await client.query('BEGIN');
    // One run of a rule at a time: a press and the hourly check can't both tell people.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('automation-rule'), $1)`, [ruleId]);
    if (cleared.length) await client.query(`DELETE FROM automation_rule_hits WHERE rule_id = $1 AND entity_id = ANY($2::text[])`, [ruleId, cleared]);
    if (hits.length) {
      await client.query(
        `INSERT INTO automation_rule_hits (rule_id, entity_id) SELECT $1, unnest($2::text[])
         ON CONFLICT (rule_id, entity_id) DO UPDATE SET last_seen = now()`, [ruleId, hits.map((h) => h.id)]);
    }
    if (action.type === 'NOTIFY' && fresh.length) {
      const { subject, message } = notice(rule.rule_name, rule.trigger_event, fresh, hits.length);
      await client.query(
        `INSERT INTO notifications (notification_type, recipient, subject, message, data, status) VALUES ($1, $2, $3, $4, $5, 'PENDING')`,
        [rule.trigger_event, action.to, subject, message, JSON.stringify({ ruleId, trigger: rule.trigger_event, ids: fresh.slice(0, 500).map((h) => h.id) })]);
      result.notified = true;
    }
    await client.query('COMMIT');
    // Drafting takes its own lock and transaction; an item with an open purchase order isn't drafted again.
    if (action.type === 'DRAFT_PO' && hits.length && opts.draftPos) result.drafted = await opts.draftPos(`${by} (rule ${rule.rule_name})`);
    await record(ruleId, by, 'SUCCESS', result, null, Date.now() - started);
    return result;
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    if (!opts.preview && err.status !== 404) await record(ruleId, by, 'FAILED', result, err.message, Date.now() - started).catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function record(ruleId: number, by: string, status: string, r: RunResult | null, error: string | null, ms: number) {
  const summary = r ? { total: r.total, fresh: r.fresh, cleared: r.cleared, notified: r.notified, drafted: r.drafted } : null;
  await pool.query(`UPDATE automation_rules SET last_run_at = now(), last_result = $2 WHERE id = $1`, [ruleId, JSON.stringify({ status, by, error, ...summary })]);
  await pool.query(`INSERT INTO automation_executions (rule_id, triggered_by, status, result_data, error_message, execution_time_ms) VALUES ($1, $2, $3, $4, $5, $6)`,
    [ruleId, by, status, JSON.stringify(summary), error, ms]);
  await pool.query(`INSERT INTO event_log (event_type, entity_type, entity_id, action, user_id, status, error_message, details) VALUES ('RULE_RUN', 'AUTOMATION_RULE', $1, $2, $3, $4, $5, $6)`,
    [String(ruleId), by === 'schedule' ? 'SCHEDULED' : 'BY_HAND', by, status, error, JSON.stringify(summary)]);
}

/** The hourly check: every active rule that is due. Returns a line for the job's last result. */
export async function runDueRules(draftPos?: (who: string) => Promise<string[]>): Promise<string> {
  const { rows } = await pool.query(`SELECT id, every, last_run_at FROM automation_rules WHERE is_active IS NOT FALSE AND every IS NOT NULL ORDER BY priority DESC, id`);
  const due = rows.filter((r: any) => isDue(r.every, r.last_run_at));
  let told = 0; let failed = 0; let drafted = 0;
  for (const r of due) {
    try { const out = await runRule(r.id, 'schedule', { draftPos }); if (out.notified) told++; drafted += out.drafted.length; }
    catch { failed++; }
  }
  if (!due.length) return 'No rules were due.';
  return `${due.length} rule${due.length === 1 ? '' : 's'} checked: ${told} told people about something new${drafted ? `, ${drafted} purchase order${drafted === 1 ? '' : 's'} drafted` : ''}${failed ? `, ${failed} failed` : ''}.`;
}
