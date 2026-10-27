// Quality & Compliance: inspections with their results, defects through to
// closure, numbered non-conformance reports, and compliance checkpoints with
// the checks made against them. Tables: ./phase5-db (columns added below).
//
//   GET    /api/quality/summary                 the dashboard's numbers, all computed
//   GET    /api/qa-inspections?status=          POST {component_id, inspection_type, sample_size, scheduled_date?, batch_id?, inspector_id?, notes?}
//   PUT    /api/qa-inspections/:id/result       {result: PASSED | FAILED | HOLD, defects_found, notes}
//   PUT    /api/qa-inspections/:id/start        in progress
//   DELETE /api/qa-inspections/:id              only one not started
//   GET    /api/defects?status=                 POST {component_id, defect_code, severity, description, qa_inspection_id?, assigned_to?}
//   PUT    /api/defects/:id                     {status?, root_cause?, resolution_notes?, assigned_to?}
//   GET    /api/ncr?status=                     POST {component_id, issue_description, severity, supplier_id?, immediate_action?, discovered_date?, assigned_to?, due_date?}
//   PUT    /api/ncr/:id                         any of {status, assigned_to, due_date, resolution_notes, immediate_action}
//   GET    /api/compliance-checkpoints          with each one's last check; POST {checkpoint_name, compliance_standard, stage, required_documentation[]}
//   PUT    /api/compliance-checkpoints/:id      {…, is_active}
//   GET    /api/compliance-records?checkpoint=  POST {compliance_checkpoint_id, status, batch_id?, notes?}
// Writes need quality.update (./writeAccess).

import type { Express } from 'express';
import { pool, query, queryOne, exec } from './db';
import { nextDocNumber } from './bookkeeping-db';

export async function ensureQualitySchema(run: (sql: string) => Promise<void> = exec): Promise<void> {
  await run(`ALTER TABLE defects ADD COLUMN IF NOT EXISTS component_id TEXT`);
  await run(`ALTER TABLE defects ADD COLUMN IF NOT EXISTS assigned_to TEXT`);
  await run(`ALTER TABLE defects ADD COLUMN IF NOT EXISTS resolution_notes TEXT`);
  await run(`ALTER TABLE defects ADD COLUMN IF NOT EXISTS reported_by TEXT`);
  await run(`ALTER TABLE non_conformance_reports ADD COLUMN IF NOT EXISTS immediate_action TEXT`);
  await run(`ALTER TABLE non_conformance_reports ADD COLUMN IF NOT EXISTS discovered_date DATE`);
  await run(`ALTER TABLE non_conformance_reports ADD COLUMN IF NOT EXISTS qa_inspection_id INTEGER`);
  await run(`ALTER TABLE compliance_records ADD COLUMN IF NOT EXISTS reference TEXT`);
  await run(`CREATE SEQUENCE IF NOT EXISTS ncr_seq START 1`);
}

// ---------------------------------------------------------------------------
// The rules, without a database.

export const INSPECTION_TYPES = ['INCOMING', 'IN_PROCESS', 'FINAL'] as const;
export const SEVERITIES = ['CRITICAL', 'MAJOR', 'MINOR'] as const;
export const DEFECT_STATUSES = ['OPEN', 'INVESTIGATING', 'RESOLVED', 'CLOSED'] as const;
export const NCR_STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const;
export const COMPLIANCE_RESULTS = ['COMPLIANT', 'NON_COMPLIANT', 'WAIVED'] as const;
const one = <T extends readonly string[]>(list: T, v: unknown): T[number] | null => {
  const u = String(v ?? '').trim().toUpperCase();
  return (list as readonly string[]).includes(u) ? (u as T[number]) : null;
};
const text = (v: unknown, max = 2000) => { const t = String(v ?? '').trim(); return t ? t.slice(0, max) : null; };
const dateOnly = (v: unknown) => { const t = String(v ?? '').trim(); return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null; };

/** Whether an NCR can move to a status: assigning needs someone, resolving and closing need what was done. */
export function ncrStepError(to: string, ncr: { assigned_to?: string | null; resolution_notes?: string | null }): string | null {
  if ((to === 'ASSIGNED' || to === 'IN_PROGRESS') && !text(ncr.assigned_to)) return 'Say who it is assigned to.';
  if ((to === 'RESOLVED' || to === 'CLOSED') && !text(ncr.resolution_notes)) return 'Say what was done about it (the resolution) before resolving or closing it.';
  return null;
}

/** The same for a defect: resolving or closing needs what was done. */
export function defectStepError(to: string, d: { resolution_notes?: string | null; root_cause?: string | null }): string | null {
  if ((to === 'RESOLVED' || to === 'CLOSED') && !text(d.resolution_notes)) return 'Say how it was fixed before resolving or closing it.';
  return null;
}

/** Defect rate: defects found per unit sampled, over completed inspections; null with nothing sampled. */
export function defectRate(inspections: Array<{ status: string; sample_size: number | null; defects_found: number | null }>): number | null {
  const done = inspections.filter((i) => ['PASSED', 'FAILED', 'HOLD'].includes(i.status) && Number(i.sample_size) > 0);
  const sampled = done.reduce((s, i) => s + Number(i.sample_size), 0);
  if (!sampled) return null;
  return Math.round((done.reduce((s, i) => s + (Number(i.defects_found) || 0), 0) / sampled) * 10000) / 100;
}

// ---------------------------------------------------------------------------

const httpError = (res: any, err: any) => res.status(err.status || 500).json({ error: err.message });
const bad = (res: any, msg: string) => res.status(400).json({ error: msg });

async function itemExists(code: string): Promise<string | null> {
  const row = await queryOne(`SELECT serial_number FROM inventory WHERE UPPER(serial_number) = UPPER($1) AND deleted IS NOT TRUE ORDER BY serial_number = $1 DESC LIMIT 1`, [code]);
  return row?.serial_number ?? null;
}

export function registerQualityRoutes(app: Express): void {
  app.get('/api/quality/summary', async (_req, res) => {
    try {
      const { rows: insp } = await query(`SELECT status, sample_size, defects_found FROM qa_inspections`);
      const [ins] = (await query(`SELECT
          COUNT(*) FILTER (WHERE status = 'PASSED')::int passed, COUNT(*) FILTER (WHERE status = 'FAILED')::int failed,
          COUNT(*) FILTER (WHERE status = 'HOLD')::int hold, COUNT(*) FILTER (WHERE status IN ('SCHEDULED', 'IN_PROGRESS'))::int open,
          COUNT(*) FILTER (WHERE status IN ('SCHEDULED', 'IN_PROGRESS') AND scheduled_date < CURRENT_DATE)::int overdue
        FROM qa_inspections`)).rows;
      const [def] = (await query(`SELECT COUNT(*) FILTER (WHERE status IN ('OPEN', 'INVESTIGATING'))::int open,
          COUNT(*) FILTER (WHERE status IN ('OPEN', 'INVESTIGATING') AND severity = 'CRITICAL')::int critical,
          COUNT(*) FILTER (WHERE status IN ('OPEN', 'INVESTIGATING') AND severity = 'MAJOR')::int major,
          COUNT(*) FILTER (WHERE status IN ('OPEN', 'INVESTIGATING') AND severity = 'MINOR')::int minor FROM defects`)).rows;
      const [ncr] = (await query(`SELECT COUNT(*) FILTER (WHERE status NOT IN ('RESOLVED', 'CLOSED'))::int open,
          COUNT(*) FILTER (WHERE status NOT IN ('RESOLVED', 'CLOSED') AND due_date < CURRENT_DATE)::int overdue,
          COUNT(*) FILTER (WHERE resolved_date IS NOT NULL)::int resolved,
          ROUND(AVG(EXTRACT(EPOCH FROM (resolved_date - reported_date)) / 86400) FILTER (WHERE resolved_date IS NOT NULL), 1)::float avg_days
        FROM non_conformance_reports`)).rows;
      const [comp] = (await query(`SELECT COUNT(*)::int checkpoints,
          COUNT(*) FILTER (WHERE last.status IS NULL)::int never, COUNT(*) FILTER (WHERE last.status = 'NON_COMPLIANT')::int failing
        FROM compliance_checkpoints c LEFT JOIN LATERAL (SELECT status FROM compliance_records r WHERE r.compliance_checkpoint_id = c.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1) last ON true
        WHERE c.is_active IS NOT FALSE`)).rows;
      const done = ins.passed + ins.failed + ins.hold;
      res.json({
        inspections: { ...ins, done, passRate: done ? Math.round((ins.passed / done) * 1000) / 10 : null },
        defectRate: defectRate(insp), defects: def, ncrs: ncr, compliance: comp,
      });
    } catch (err) { httpError(res, err); }
  });

  // ---- Inspections --------------------------------------------------------
  app.get('/api/qa-inspections', async (req, res) => {
    const status = one(['SCHEDULED', 'IN_PROGRESS', 'PASSED', 'FAILED', 'HOLD'] as const, req.query.status);
    try {
      const { rows } = await query(`SELECT q.*, i.name AS item_name, to_char(q.scheduled_date, 'YYYY-MM-DD') AS scheduled_day,
          (SELECT COUNT(*)::int FROM defects d WHERE d.qa_inspection_id = q.id) AS defects_logged,
          (SELECT n.ncr_number FROM non_conformance_reports n WHERE n.qa_inspection_id = q.id ORDER BY n.id LIMIT 1) AS ncr_number
        FROM qa_inspections q LEFT JOIN inventory i ON i.serial_number = q.component_id
        ${status ? 'WHERE q.status = $1' : ''} ORDER BY (q.status IN ('SCHEDULED', 'IN_PROGRESS')) DESC, COALESCE(q.completed_date, q.scheduled_date, q.created_at) DESC LIMIT 300`, status ? [status] : []);
      res.json(rows);
    } catch (err) { httpError(res, err); }
  });

  app.post('/api/qa-inspections', async (req: any, res) => {
    const b = req.body ?? {};
    const type = one(INSPECTION_TYPES, b.inspection_type);
    const sample = Math.floor(Number(b.sample_size));
    if (!type) return bad(res, 'Choose the kind of inspection: incoming, in-process or final.');
    if (!(sample > 0)) return bad(res, 'The sample size is a whole number of 1 or more.');
    try {
      const code = await itemExists(String(b.component_id ?? '').trim());
      if (!code) return bad(res, `${b.component_id || 'That item'} isn't in inventory.`);
      const row = await queryOne(
        `INSERT INTO qa_inspections (inspection_type, component_id, batch_id, inspector_id, scheduled_date, sample_size, notes, status)
         VALUES ($1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE), $6, $7, 'SCHEDULED') RETURNING *`,
        [type, code, text(b.batch_id, 120), text(b.inspector_id, 120) ?? req.user?.email ?? 'unknown', dateOnly(b.scheduled_date), sample, text(b.notes)]);
      res.status(201).json(row);
    } catch (err) { httpError(res, err); }
  });

  app.put('/api/qa-inspections/:id/start', async (req, res) => {
    try {
      const row = await queryOne(`UPDATE qa_inspections SET status = 'IN_PROGRESS', updated_at = now() WHERE id = $1 AND status = 'SCHEDULED' RETURNING *`, [parseInt(req.params.id)]);
      if (!row) return res.status(409).json({ error: 'Only a scheduled inspection can be started.' });
      res.json(row);
    } catch (err) { httpError(res, err); }
  });

  app.put('/api/qa-inspections/:id/result', async (req, res) => {
    const b = req.body ?? {};
    const result = one(['PASSED', 'FAILED', 'HOLD'] as const, b.result);
    const found = Math.floor(Number(b.defects_found ?? 0));
    if (!result) return bad(res, 'Choose passed, failed or on hold.');
    if (!(found >= 0)) return bad(res, 'Defects found is a whole number of 0 or more.');
    try {
      const cur = await queryOne(`SELECT sample_size FROM qa_inspections WHERE id = $1`, [parseInt(req.params.id)]);
      if (!cur) return res.status(404).json({ error: 'Inspection not found.' });
      if (cur.sample_size && found > cur.sample_size) return bad(res, `More defects than units sampled (${cur.sample_size})?`);
      if (result === 'FAILED' && found === 0 && !text(b.notes)) return bad(res, 'A failed inspection needs the defects found, or a note saying why it failed.');
      const row = await queryOne(`UPDATE qa_inspections SET status = $2, defects_found = $3, notes = COALESCE($4, notes), completed_date = now(), updated_at = now() WHERE id = $1 RETURNING *`,
        [parseInt(req.params.id), result, found, text(b.notes)]);
      res.json(row);
    } catch (err) { httpError(res, err); }
  });

  app.delete('/api/qa-inspections/:id', async (req, res) => {
    try {
      const { rowCount } = await query(`DELETE FROM qa_inspections q WHERE id = $1 AND status = 'SCHEDULED' AND NOT EXISTS (SELECT 1 FROM defects d WHERE d.qa_inspection_id = q.id)`, [parseInt(req.params.id)]);
      if (!rowCount) return res.status(409).json({ error: 'Only an inspection that hasn\'t started can be deleted.' });
      res.json({ ok: true });
    } catch (err) { httpError(res, err); }
  });

  // ---- Defects ------------------------------------------------------------
  app.get('/api/defects', async (req, res) => {
    const status = one(DEFECT_STATUSES, req.query.status);
    const open = req.query.status === 'open';
    try {
      const { rows } = await query(`SELECT d.*, i.name AS item_name, q.inspection_type FROM defects d LEFT JOIN inventory i ON i.serial_number = d.component_id LEFT JOIN qa_inspections q ON q.id = d.qa_inspection_id
        ${status ? 'WHERE d.status = $1' : open ? `WHERE d.status IN ('OPEN', 'INVESTIGATING')` : ''}
        ORDER BY (d.status IN ('OPEN', 'INVESTIGATING')) DESC, CASE d.severity WHEN 'CRITICAL' THEN 0 WHEN 'MAJOR' THEN 1 ELSE 2 END, d.created_at DESC LIMIT 300`, status ? [status] : []);
      res.json(rows);
    } catch (err) { httpError(res, err); }
  });

  app.post('/api/defects', async (req: any, res) => {
    const b = req.body ?? {};
    const severity = one(SEVERITIES, b.severity);
    if (!severity) return bad(res, 'Choose how serious it is: critical, major or minor.');
    if (!text(b.description)) return bad(res, 'Describe the defect.');
    try {
      const code = await itemExists(String(b.component_id ?? '').trim());
      if (!code) return bad(res, `${b.component_id || 'That item'} isn't in inventory.`);
      const inspection = b.qa_inspection_id ? parseInt(b.qa_inspection_id) : null;
      const row = await queryOne(
        `INSERT INTO defects (qa_inspection_id, component_id, defect_code, severity, description, root_cause, assigned_to, reported_by, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'OPEN') RETURNING *`,
        [inspection, code, text(b.defect_code, 60) ?? severity, severity, text(b.description), text(b.root_cause), text(b.assigned_to, 120), req.user?.email ?? null]);
      res.status(201).json(row);
    } catch (err) { httpError(res, err); }
  });

  app.put('/api/defects/:id', async (req, res) => {
    const b = req.body ?? {};
    try {
      const cur = await queryOne(`SELECT * FROM defects WHERE id = $1`, [parseInt(req.params.id)]);
      if (!cur) return res.status(404).json({ error: 'Defect not found.' });
      const next = {
        status: b.status !== undefined ? one(DEFECT_STATUSES, b.status) : cur.status,
        root_cause: b.root_cause !== undefined ? text(b.root_cause) : cur.root_cause,
        resolution_notes: b.resolution_notes !== undefined ? text(b.resolution_notes) : cur.resolution_notes,
        assigned_to: b.assigned_to !== undefined ? text(b.assigned_to, 120) : cur.assigned_to,
      };
      if (!next.status) return bad(res, 'That isn\'t a defect status.');
      const err = defectStepError(next.status, next);
      if (err) return bad(res, err);
      const row = await queryOne(
        `UPDATE defects SET status = $2, root_cause = $3, resolution_notes = $4, assigned_to = $5,
           resolved_at = CASE WHEN $2 IN ('RESOLVED', 'CLOSED') THEN COALESCE(resolved_at, now()) ELSE NULL END WHERE id = $1 RETURNING *`,
        [cur.id, next.status, next.root_cause, next.resolution_notes, next.assigned_to]);
      res.json(row);
    } catch (err) { httpError(res, err); }
  });

  // ---- Non-conformance reports ---------------------------------------------
  app.get('/api/ncr', async (req, res) => {
    const status = one(NCR_STATUSES, req.query.status);
    try {
      const { rows } = await query(`SELECT n.*, i.name AS item_name, s.name AS supplier_name, to_char(n.due_date, 'YYYY-MM-DD') AS due_day, to_char(n.discovered_date, 'YYYY-MM-DD') AS discovered_day,
          (n.status NOT IN ('RESOLVED', 'CLOSED') AND n.due_date < CURRENT_DATE) AS overdue
        FROM non_conformance_reports n LEFT JOIN inventory i ON i.serial_number = n.component_id LEFT JOIN suppliers s ON s.id::text = n.supplier_id
        ${status ? 'WHERE n.status = $1' : ''} ORDER BY (n.status IN ('RESOLVED', 'CLOSED')), n.id DESC LIMIT 300`, status ? [status] : []);
      res.json(rows);
    } catch (err) { httpError(res, err); }
  });

  app.post('/api/ncr', async (req: any, res) => {
    const b = req.body ?? {};
    const severity = one(SEVERITIES, b.severity);
    if (!severity) return bad(res, 'Choose how serious it is: critical, major or minor.');
    if (!text(b.issue_description)) return bad(res, 'Describe what doesn\'t conform.');
    const client = await pool.connect();
    try {
      const code = await itemExists(String(b.component_id ?? '').trim());
      if (!code) return bad(res, `${b.component_id || 'That item'} isn't in inventory.`);
      await client.query('BEGIN');
      const number = await nextDocNumber(client as any, 'NCR', 'ncr_seq');
      const assigned = text(b.assigned_to, 120);
      const { rows: [row] } = await client.query(
        `INSERT INTO non_conformance_reports (ncr_number, component_id, supplier_id, issue_description, severity, reported_by, status, assigned_to, due_date, immediate_action, discovered_date, qa_inspection_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10, COALESCE($11::date, CURRENT_DATE), $12) RETURNING *`,
        [number, code, text(b.supplier_id, 40), text(b.issue_description), severity, req.user?.email ?? 'unknown', assigned ? 'ASSIGNED' : 'OPEN', assigned,
          dateOnly(b.due_date), text(b.immediate_action), dateOnly(b.discovered_date), b.qa_inspection_id ? parseInt(b.qa_inspection_id) : null]);
      await client.query('COMMIT');
      res.status(201).json(row);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      httpError(res, err);
    } finally { client.release(); }
  });

  app.put('/api/ncr/:id', async (req, res) => {
    const b = req.body ?? {};
    try {
      const cur = await queryOne(`SELECT * FROM non_conformance_reports WHERE id = $1`, [parseInt(req.params.id)]);
      if (!cur) return res.status(404).json({ error: 'NCR not found.' });
      const next = {
        status: b.status !== undefined ? one(NCR_STATUSES, b.status) : cur.status,
        assigned_to: b.assigned_to !== undefined ? text(b.assigned_to, 120) : cur.assigned_to,
        due_date: b.due_date !== undefined ? dateOnly(b.due_date) : cur.due_date,
        resolution_notes: b.resolution_notes !== undefined ? text(b.resolution_notes) : cur.resolution_notes,
        immediate_action: b.immediate_action !== undefined ? text(b.immediate_action) : cur.immediate_action,
      };
      if (!next.status) return bad(res, 'That isn\'t an NCR status.');
      const err = ncrStepError(next.status, next);
      if (err) return bad(res, err);
      const row = await queryOne(
        `UPDATE non_conformance_reports SET status = $2, assigned_to = $3, due_date = $4, resolution_notes = $5, immediate_action = $6,
           resolved_date = CASE WHEN $2 IN ('RESOLVED', 'CLOSED') THEN COALESCE(resolved_date, now()) ELSE NULL END, updated_at = now() WHERE id = $1 RETURNING *`,
        [cur.id, next.status, next.assigned_to, next.due_date, next.resolution_notes, next.immediate_action]);
      res.json(row);
    } catch (err) { httpError(res, err); }
  });

  // ---- Compliance ---------------------------------------------------------
  app.get('/api/compliance-checkpoints', async (_req, res) => {
    try {
      const { rows } = await query(`SELECT c.*, last.status AS last_status, last.verified_by AS last_by, last.verified_date AS last_at, last.reference AS last_reference,
          (SELECT COUNT(*)::int FROM compliance_records r WHERE r.compliance_checkpoint_id = c.id) AS checks
        FROM compliance_checkpoints c LEFT JOIN LATERAL (SELECT * FROM compliance_records r WHERE r.compliance_checkpoint_id = c.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1) last ON true
        ORDER BY c.is_active DESC, c.compliance_standard, c.checkpoint_name`);
      res.json(rows);
    } catch (err) { httpError(res, err); }
  });

  const checkpointFields = (b: any) => ({
    name: text(b.checkpoint_name, 160), standard: text(b.compliance_standard, 80), stage: text(b.stage, 80),
    docs: Array.isArray(b.required_documentation) ? b.required_documentation.map((d: unknown) => text(d, 160)).filter(Boolean) : [],
  });
  app.post('/api/compliance-checkpoints', async (req, res) => {
    const f = checkpointFields(req.body ?? {});
    if (!f.name || !f.standard || !f.stage) return bad(res, 'A checkpoint needs a name, the standard (e.g. ISO 9001) and the stage it applies to.');
    try {
      const row = await queryOne(`INSERT INTO compliance_checkpoints (checkpoint_name, compliance_standard, stage, required_documentation) VALUES ($1, $2, $3, $4) RETURNING *`,
        [f.name, f.standard, f.stage, JSON.stringify(f.docs)]);
      res.status(201).json(row);
    } catch (err) { httpError(res, err); }
  });

  app.put('/api/compliance-checkpoints/:id', async (req, res) => {
    const b = req.body ?? {};
    try {
      const cur = await queryOne(`SELECT * FROM compliance_checkpoints WHERE id = $1`, [parseInt(req.params.id)]);
      if (!cur) return res.status(404).json({ error: 'Checkpoint not found.' });
      const f = checkpointFields({ checkpoint_name: cur.checkpoint_name, compliance_standard: cur.compliance_standard, stage: cur.stage, required_documentation: cur.required_documentation, ...b });
      if (!f.name || !f.standard || !f.stage) return bad(res, 'A checkpoint needs a name, the standard and the stage.');
      const row = await queryOne(`UPDATE compliance_checkpoints SET checkpoint_name = $2, compliance_standard = $3, stage = $4, required_documentation = $5, is_active = $6, updated_at = now() WHERE id = $1 RETURNING *`,
        [cur.id, f.name, f.standard, f.stage, JSON.stringify(f.docs), b.is_active === undefined ? cur.is_active : !!b.is_active]);
      res.json(row);
    } catch (err) { httpError(res, err); }
  });

  app.get('/api/compliance-records', async (req, res) => {
    const cp = req.query.checkpoint ? parseInt(req.query.checkpoint as string) : null;
    try {
      const { rows } = await query(`SELECT r.*, c.checkpoint_name, c.compliance_standard FROM compliance_records r JOIN compliance_checkpoints c ON c.id = r.compliance_checkpoint_id
        ${cp ? 'WHERE r.compliance_checkpoint_id = $1' : ''} ORDER BY r.created_at DESC, r.id DESC LIMIT 200`, cp ? [cp] : []);
      res.json(rows);
    } catch (err) { httpError(res, err); }
  });

  app.post('/api/compliance-records', async (req: any, res) => {
    const b = req.body ?? {};
    const status = one(COMPLIANCE_RESULTS, b.status);
    if (!status) return bad(res, 'Choose compliant, not compliant or waived.');
    if (status !== 'COMPLIANT' && !text(b.notes)) return bad(res, status === 'WAIVED' ? 'Say why it is waived.' : 'Say what isn\'t compliant.');
    try {
      const cp = await queryOne(`SELECT id FROM compliance_checkpoints WHERE id = $1`, [parseInt(b.compliance_checkpoint_id)]);
      if (!cp) return bad(res, 'Choose the checkpoint.');
      const row = await queryOne(
        `INSERT INTO compliance_records (compliance_checkpoint_id, batch_id, reference, status, verified_by, verified_date, notes) VALUES ($1, $2, $3, $4, $5, now(), $6) RETURNING *`,
        [cp.id, text(b.batch_id, 120), text(b.reference, 160), status, req.user?.email ?? 'unknown', text(b.notes)]);
      res.status(201).json(row);
    } catch (err) { httpError(res, err); }
  });
}
