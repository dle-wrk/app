// Project progress: which stage each project is at, so several projects
// running at the same time can be followed on one board (Projects → Project
// Progress, components/views/ProjectProgressView).
//
//   GET  /api/project-progress               the stages, and every project with its stage, hold, latest note and signals
//   GET  /api/project-progress/:id/history   everything recorded for one project, newest first
//   POST /api/project-progress/:id/stage     move a project to a stage: {stageId, note?}
//   POST /api/project-progress/:id/hold      put a project on hold, or resume it: {onHold, reason?}
//   POST /api/project-progress/:id/update    add a progress update: {note}
//   PUT  /api/project-progress/stages        change the stage list (admins): {stages: [{id?, name}]}, in order
//
// Everyone signed in can look. Moving, holding and updates need a role that
// may update projects (admin, manager, engineer). Each is recorded in
// project_progress_log with who and when, and in the activity log.
//
// A project that was never moved shows in the first stage. The log keeps the
// stage names as they were, so renaming or removing a stage later doesn't
// rewrite history. A stage that has projects in it can't be removed. Deleting
// a project deletes its progress too (see projectsRoutes), because project
// ids get reused.

import type { Express } from 'express';
import type { PoolClient } from 'pg';
import { pool, query, exec } from './db';
import { requirePermission } from './authRoutes';
import { roleCan } from './permissions';
import { DEFAULT_STAGES, checkStageList, cleanNote, effectiveStage, type Stage } from './projectStages';

export class ProgressError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export type LogKind = 'stage' | 'hold' | 'resume' | 'update';

export interface LogEntry {
  id: number;
  kind: LogKind;
  fromStage: string | null;
  toStage: string | null;
  note: string | null;
  by: string | null;
  at: string | null;
}

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(v as any).toISOString());

export async function ensureProjectProgressSchema(run: (sql: string) => Promise<void> = exec): Promise<void> {
  await run(`CREATE TABLE IF NOT EXISTS project_stages (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS project_stages_name_key ON project_stages (lower(name))`);
  // The default stages, once. The unique names make a second machine
  // starting at the same moment add nothing.
  const values = DEFAULT_STAGES.map((name, i) => `('${name.replace(/'/g, "''")}', ${i})`).join(', ');
  await run(`INSERT INTO project_stages (name, position)
    SELECT v.name, v.position FROM (VALUES ${values}) AS v(name, position)
     WHERE NOT EXISTS (SELECT 1 FROM project_stages)
    ON CONFLICT DO NOTHING`);
  await run(`CREATE TABLE IF NOT EXISTS project_progress (
    project_id INTEGER PRIMARY KEY,
    stage_id INTEGER REFERENCES project_stages(id),
    stage_since TIMESTAMPTZ,
    stage_by TEXT,
    on_hold BOOLEAN NOT NULL DEFAULT FALSE,
    hold_reason TEXT,
    hold_since TIMESTAMPTZ,
    hold_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await run(`CREATE TABLE IF NOT EXISTS project_progress_log (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    from_stage TEXT,
    to_stage TEXT,
    note TEXT,
    by_user TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await run(`CREATE INDEX IF NOT EXISTS project_progress_log_project_idx ON project_progress_log (project_id, created_at DESC, id DESC)`);
}

const STAGES_SQL = `SELECT id, name, position FROM project_stages ORDER BY position, id`;

// One row per project, with its progress and what the rest of the app says
// about it: saved kits (Kit Booking), builds (job cards), the latest thing
// someone wrote about it, and when anything last changed. Project ids are
// text in this table; one that isn't a number can't have progress and is
// left out rather than failing the whole board.
const BOARD_SQL = `
  WITH p AS (
    SELECT pr.*, CASE WHEN TRIM(pr.id) ~ '^[0-9]{1,9}$' THEN TRIM(pr.id)::int END AS pid
      FROM projects pr
  )
  SELECT p.pid, p.project_name, p.status, p.assigned_team, p.start_date, p.end_date,
         pp.stage_id, pp.stage_since, pp.stage_by, COALESCE(pp.on_hold, FALSE) AS on_hold,
         pp.hold_reason, pp.hold_since, pp.hold_by,
         COALESCE(k.kit_count, 0) AS kit_count, k.kits_saved_at,
         COALESCE(j.building, 0) AS building, COALESCE(j.building_qty, 0) AS building_qty, COALESCE(j.built, 0) AS built,
         n.kind AS note_kind, n.note, n.by_user AS note_by, n.created_at AS note_at,
         GREATEST(p.updated_at, k.kits_saved_at, pp.updated_at) AS last_activity_at
    FROM p
    LEFT JOIN project_progress pp ON pp.project_id = p.pid
    LEFT JOIN (SELECT project_id, COUNT(*)::int AS kit_count, MAX(updated_at) AS kits_saved_at
                 FROM kits GROUP BY project_id) k ON k.project_id = p.pid
    LEFT JOIN (SELECT project_id,
                      (COUNT(*) FILTER (WHERE LOWER(TRIM(status)) = 'in progress'))::int AS building,
                      (COALESCE(SUM(build_qty) FILTER (WHERE LOWER(TRIM(status)) = 'in progress'), 0))::int AS building_qty,
                      (COUNT(*) FILTER (WHERE LOWER(TRIM(status)) = 'completed'))::int AS built
                 FROM job_cards GROUP BY project_id) j ON j.project_id = p.pid
    LEFT JOIN LATERAL (SELECT l.kind, l.note, l.by_user, l.created_at
                         FROM project_progress_log l
                        WHERE l.project_id = p.pid AND l.note IS NOT NULL
                        ORDER BY l.created_at DESC, l.id DESC
                        LIMIT 1) n ON TRUE
   WHERE p.pid IS NOT NULL
   ORDER BY p.pid`;

const mapStage = (r: any): Stage => ({ id: Number(r.id), name: r.name, position: Number(r.position) });

export function mapLog(r: any): LogEntry {
  return {
    id: Number(r.id),
    kind: r.kind,
    fromStage: r.from_stage ?? null,
    toStage: r.to_stage ?? null,
    note: r.note ?? null,
    by: r.by_user ?? null,
    at: iso(r.created_at),
  };
}

export function mapBoardProject(r: any, stages: Stage[]) {
  const stage = effectiveStage(stages, r.stage_id);
  return {
    id: Number(r.pid),
    name: r.project_name || `Project ${r.pid}`,
    status: r.status ?? null,
    team: r.assigned_team || null,
    startDate: r.start_date || null,
    endDate: r.end_date || null,
    /** The stage it shows in; the first one when it was never moved. */
    stageId: stage?.id ?? null,
    stageSet: r.stage_id !== null && r.stage_id !== undefined && stage?.id === Number(r.stage_id),
    stageSince: iso(r.stage_since),
    stageBy: r.stage_by ?? null,
    onHold: r.on_hold === true,
    holdReason: r.hold_reason ?? null,
    holdSince: iso(r.hold_since),
    holdBy: r.hold_by ?? null,
    lastNote: r.note_at ? { kind: r.note_kind as LogKind, note: r.note as string, by: r.note_by ?? null, at: iso(r.note_at) } : null,
    kits: { count: Number(r.kit_count) || 0, lastSavedAt: iso(r.kits_saved_at) },
    builds: { inProgress: Number(r.building) || 0, inProgressQty: Number(r.building_qty) || 0, completed: Number(r.built) || 0 },
    lastActivityAt: iso(r.last_activity_at),
  };
}

export type BoardProject = ReturnType<typeof mapBoardProject>;

export async function loadBoard(role: string | null) {
  const { rows: stageRows } = await query(STAGES_SQL);
  const stages = stageRows.map(mapStage);
  const { rows } = await query(BOARD_SQL);
  return {
    stages,
    projects: rows.map((r) => mapBoardProject(r, stages)),
    can: { move: roleCan(role, 'projects.update'), editStages: roleCan(role, 'settings.update') },
  };
}

async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

type Queryable = { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> };

async function projectName(db: Queryable, projectId: number): Promise<string> {
  const { rows } = await db.query(`SELECT project_name FROM projects WHERE TRIM(id) = $1`, [String(projectId)]);
  if (!rows.length) throw new ProgressError(404, 'That project no longer exists.');
  return rows[0].project_name || `Project ${projectId}`;
}

async function addLog(client: PoolClient, projectId: number, kind: LogKind, from: string | null, to: string | null, note: string | null, who: string): Promise<LogEntry> {
  const { rows } = await client.query(
    `INSERT INTO project_progress_log (project_id, kind, from_stage, to_stage, note, by_user)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, kind, from_stage, to_stage, note, by_user, created_at`,
    [projectId, kind, from, to, note, who]
  );
  return mapLog(rows[0]);
}

// The activity log is a record for admins; failing to write it never undoes the change.
async function logActivity(who: string, action: string, entityType: string, entityId: string | null, details: Record<string, unknown>): Promise<void> {
  await query(
    `INSERT INTO user_activity_logs (user_email, action, entity_type, entity_id, details, status) VALUES ($1, $2, $3, $4, $5, 'SUCCESS')`,
    [who, action, entityType, entityId, JSON.stringify(details)]
  ).catch(() => {});
}

export async function moveProject(projectId: number, stageId: number, note: string | null, who: string) {
  const done = await inTransaction(async (client) => {
    const name = await projectName(client, projectId);
    // FOR SHARE: a stage list being saved at the same moment waits for this move, and sees it.
    const { rows: [stage] } = await client.query(`SELECT id, name FROM project_stages WHERE id = $1 FOR SHARE`, [stageId]);
    if (!stage) throw new ProgressError(409, 'That stage has been removed. Reload the board and try again.');
    const { rows: [current] } = await client.query(
      `SELECT pp.stage_id, s.name AS stage_name
         FROM project_progress pp LEFT JOIN project_stages s ON s.id = pp.stage_id
        WHERE pp.project_id = $1 FOR UPDATE OF pp`,
      [projectId]
    );
    if (current && Number(current.stage_id) === Number(stage.id)) throw new ProgressError(409, `${name} is already in ${stage.name}.`);
    await client.query(
      `INSERT INTO project_progress (project_id, stage_id, stage_since, stage_by, updated_at) VALUES ($1, $2, now(), $3, now())
       ON CONFLICT (project_id) DO UPDATE SET stage_id = EXCLUDED.stage_id, stage_since = EXCLUDED.stage_since,
         stage_by = EXCLUDED.stage_by, updated_at = EXCLUDED.updated_at`,
      [projectId, stage.id, who]
    );
    const from: string | null = current?.stage_name ?? null;
    const entry = await addLog(client, projectId, 'stage', from, stage.name, note, who);
    return { name, stage, from, entry };
  });
  await logActivity(who, 'MOVE_PROJECT_STAGE', 'Project', String(projectId), { project: done.name, from: done.from, to: done.stage.name, ...(note ? { note } : {}) });
  return { projectId, stageId: Number(done.stage.id), stageName: done.stage.name as string, entry: done.entry };
}

export async function setHold(projectId: number, onHold: boolean, reason: string | null, who: string) {
  const done = await inTransaction(async (client) => {
    const name = await projectName(client, projectId);
    const { rows: [current] } = await client.query(`SELECT on_hold FROM project_progress WHERE project_id = $1 FOR UPDATE`, [projectId]);
    const held = current?.on_hold === true;
    if (onHold && held) throw new ProgressError(409, `${name} is already on hold.`);
    if (!onHold && !held) throw new ProgressError(409, `${name} isn't on hold.`);
    if (onHold) {
      await client.query(
        `INSERT INTO project_progress (project_id, on_hold, hold_reason, hold_since, hold_by, updated_at) VALUES ($1, TRUE, $2, now(), $3, now())
         ON CONFLICT (project_id) DO UPDATE SET on_hold = TRUE, hold_reason = EXCLUDED.hold_reason, hold_since = EXCLUDED.hold_since,
           hold_by = EXCLUDED.hold_by, updated_at = EXCLUDED.updated_at`,
        [projectId, reason, who]
      );
    } else {
      await client.query(
        `UPDATE project_progress SET on_hold = FALSE, hold_reason = NULL, hold_since = NULL, hold_by = NULL, updated_at = now() WHERE project_id = $1`,
        [projectId]
      );
    }
    const entry = await addLog(client, projectId, onHold ? 'hold' : 'resume', null, null, reason, who);
    return { name, entry };
  });
  await logActivity(who, onHold ? 'HOLD_PROJECT' : 'RESUME_PROJECT', 'Project', String(projectId), { project: done.name, ...(reason ? { reason } : {}) });
  return { projectId, onHold, entry: done.entry };
}

export async function addUpdate(projectId: number, note: string, who: string) {
  const done = await inTransaction(async (client) => {
    const name = await projectName(client, projectId);
    await client.query(
      `INSERT INTO project_progress (project_id, updated_at) VALUES ($1, now()) ON CONFLICT (project_id) DO UPDATE SET updated_at = now()`,
      [projectId]
    );
    const entry = await addLog(client, projectId, 'update', null, null, note, who);
    return { name, entry };
  });
  await logActivity(who, 'ADD_PROJECT_UPDATE', 'Project', String(projectId), { project: done.name, note });
  return { projectId, entry: done.entry };
}

export async function projectHistory(projectId: number) {
  await projectName({ query }, projectId);
  const { rows } = await query(
    `SELECT id, kind, from_stage, to_stage, note, by_user, created_at FROM project_progress_log
      WHERE project_id = $1 ORDER BY created_at DESC, id DESC LIMIT 500`,
    [projectId]
  );
  return { projectId, entries: rows.map(mapLog) };
}

export async function saveStages(input: unknown, who: string) {
  const done = await inTransaction(async (client) => {
    // One stage list edit at a time; moves wait for it (and it for them).
    await client.query('LOCK TABLE project_stages IN EXCLUSIVE MODE');
    const { rows: before } = await client.query(STAGES_SQL);
    const checked = checkStageList(input, before.map((s: any) => Number(s.id)));
    if ('error' in checked) throw new ProgressError(400, checked.error);
    const kept = checked.stages.filter((s) => s.id !== null).map((s) => s.id as number);
    const removed = before.filter((s: any) => !kept.includes(Number(s.id)));
    if (removed.length) {
      const { rows: inUse } = await client.query(
        `SELECT stage_id, COUNT(*)::int AS n FROM project_progress WHERE stage_id = ANY($1::int[]) GROUP BY stage_id ORDER BY stage_id`,
        [removed.map((s: any) => Number(s.id))]
      );
      if (inUse.length) {
        const names = inUse.map((u: any) => {
          const s = removed.find((r: any) => Number(r.id) === Number(u.stage_id));
          return `${s?.name ?? 'a stage'} (${u.n} project${u.n === 1 ? '' : 's'})`;
        });
        throw new ProgressError(409, `Move the projects out of ${names.join(' and ')} before removing ${inUse.length === 1 ? 'it' : 'them'}.`);
      }
      await client.query(`DELETE FROM project_stages WHERE id = ANY($1::int[])`, [removed.map((s: any) => Number(s.id))]);
    }
    // Free the kept stages' names first, so two stages can swap names
    // without tripping over the unique names on the way.
    if (kept.length) await client.query(`UPDATE project_stages SET name = E'\\n' || id::text WHERE id = ANY($1::int[])`, [kept]);
    for (const [position, stage] of checked.stages.entries()) {
      if (stage.id !== null) {
        await client.query(`UPDATE project_stages SET name = $2, position = $3 WHERE id = $1`, [stage.id, stage.name, position]);
      } else {
        await client.query(`INSERT INTO project_stages (name, position) VALUES ($1, $2)`, [stage.name, position]);
      }
    }
    const { rows: after } = await client.query(STAGES_SQL);
    return { before: before.map(mapStage), after: after.map(mapStage) };
  });
  await logActivity(who, 'EDIT_PROJECT_STAGES', 'ProjectStages', null, {
    before: done.before.map((s) => s.name),
    after: done.after.map((s) => s.name),
  });
  return { stages: done.after };
}

export function registerProjectProgressRoutes(app: Express): void {
  const fail = (res: any, err: any) => {
    if (err instanceof ProgressError) return res.status(err.status).json({ error: err.message });
    // A foreign key: a stage went while a move or a stage edit was saving.
    if (err?.code === '23503') return res.status(409).json({ error: 'The stages changed while saving. Reload the board and try again.' });
    res.status(500).json({ error: err?.message || String(err) });
  };
  const who = (req: any): string => req.user?.email || 'unknown';
  const projectIdOf = (req: any): number | null => {
    const id = Number(req.params.id);
    return Number.isInteger(id) && id > 0 && id < 1e9 ? id : null;
  };
  const badId = (res: any) => res.status(400).json({ error: 'That is not a project id.' });

  app.get('/api/project-progress', async (req: any, res) => {
    try {
      res.json(await loadBoard(req.user?.role ?? null));
    } catch (err) { fail(res, err); }
  });

  app.get('/api/project-progress/:id/history', async (req, res) => {
    const id = projectIdOf(req);
    if (!id) return badId(res);
    try {
      res.json(await projectHistory(id));
    } catch (err) { fail(res, err); }
  });

  const gate = requirePermission('projects.update');

  app.post('/api/project-progress/:id/stage', gate, async (req: any, res) => {
    const id = projectIdOf(req);
    if (!id) return badId(res);
    const stageId = Number(req.body?.stageId);
    if (!Number.isInteger(stageId) || stageId <= 0) return res.status(400).json({ error: 'Say which stage (stageId) to move the project to.' });
    try {
      res.json(await moveProject(id, stageId, cleanNote(req.body?.note), who(req)));
    } catch (err) { fail(res, err); }
  });

  app.post('/api/project-progress/:id/hold', gate, async (req: any, res) => {
    const id = projectIdOf(req);
    if (!id) return badId(res);
    if (typeof req.body?.onHold !== 'boolean') return res.status(400).json({ error: 'onHold must be true or false.' });
    try {
      res.json(await setHold(id, req.body.onHold, cleanNote(req.body?.reason), who(req)));
    } catch (err) { fail(res, err); }
  });

  app.post('/api/project-progress/:id/update', gate, async (req: any, res) => {
    const id = projectIdOf(req);
    if (!id) return badId(res);
    const note = cleanNote(req.body?.note);
    if (!note) return res.status(400).json({ error: 'Write the update first.' });
    try {
      res.json(await addUpdate(id, note, who(req)));
    } catch (err) { fail(res, err); }
  });

  app.put('/api/project-progress/stages', requirePermission('settings.update'), async (req: any, res) => {
    try {
      res.json(await saveStages(req.body?.stages, who(req)));
    } catch (err) { fail(res, err); }
  });
}
