// @vitest-environment node
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The Project Progress endpoints on a real Express app, against a small
// in-memory stand-in for Postgres that knows exactly the statements they
// send. BEGIN/COMMIT/ROLLBACK work on snapshots, the stage names are unique
// (ignoring case) after every statement like the real unique index, and the
// stage foreign key is enforced. Any SQL it doesn't know fails the test. The
// SQL itself was checked against Postgres separately.

type Row = Record<string, any>;
interface State {
  projects: Row[];
  stages: Row[];
  progress: Row[];
  log: Row[];
  activity: Row[];
  kits: Row[];
  jobCards: Row[];
}

const db = vi.hoisted(() => ({
  state: null as unknown as State,
  snapshot: null as null | State,
  statements: [] as string[],
  failOn: null as null | RegExp,
  failWith: null as null | (Error & { code?: string }),
  ticks: 0,
  nextStageId: 100,
  nextLogId: 100,
  released: 0,
}));

vi.mock('./db', () => {
  const clone = (s: State): State => structuredClone(s);
  const result = (rows: Row[] = [], rowCount = rows.length) => ({ rows, rowCount });
  const now = () => new Date(Date.parse('2026-10-07T08:00:00Z') + (db.ticks++) * 1000);
  const fkError = () => Object.assign(new Error('violates foreign key constraint "project_progress_stage_id_fkey"'), { code: '23503' });
  const uniqueNames = () => {
    const seen = new Set<string>();
    for (const s of db.state.stages) {
      const key = String(s.name).toLowerCase();
      if (seen.has(key)) throw Object.assign(new Error('duplicate key value violates unique constraint "project_stages_name_key"'), { code: '23505' });
      seen.add(key);
    }
  };
  const progressOf = (id: number) => db.state.progress.find((r) => r.project_id === id);
  const upsertProgress = (id: number, set: Row) => {
    const row = progressOf(id);
    if (row) Object.assign(row, set);
    else db.state.progress.push({ project_id: id, stage_id: null, stage_since: null, stage_by: null, on_hold: false, hold_reason: null, hold_since: null, hold_by: null, updated_at: now(), ...set });
  };
  const boardRows = () => db.state.projects
    .filter((p) => /^[0-9]{1,9}$/.test(String(p.id).trim()))
    .map((p) => {
      const pid = Number(String(p.id).trim());
      const pp = progressOf(pid);
      const kits = db.state.kits.filter((k) => k.project_id === pid);
      const jobs = db.state.jobCards.filter((j) => j.project_id === pid);
      const status = (j: Row) => String(j.status).trim().toLowerCase();
      const building = jobs.filter((j) => status(j) === 'in progress');
      const note = db.state.log.filter((l) => l.project_id === pid && l.note !== null)
        .sort((a, b) => +b.created_at - +a.created_at || b.id - a.id)[0];
      const kitsSavedAt = kits.length ? new Date(Math.max(...kits.map((k) => +k.updated_at))) : null;
      const times = [p.updated_at, kitsSavedAt, pp?.updated_at].filter(Boolean).map(Number);
      return {
        pid, project_name: p.project_name, status: p.status, assigned_team: p.assigned_team, start_date: p.start_date, end_date: p.end_date,
        stage_id: pp?.stage_id ?? null, stage_since: pp?.stage_since ?? null, stage_by: pp?.stage_by ?? null, on_hold: pp?.on_hold ?? false,
        hold_reason: pp?.hold_reason ?? null, hold_since: pp?.hold_since ?? null, hold_by: pp?.hold_by ?? null,
        kit_count: kits.length, kits_saved_at: kitsSavedAt,
        building: building.length, building_qty: building.reduce((n, j) => n + (j.build_qty || 0), 0), built: jobs.filter((j) => status(j) === 'completed').length,
        note_kind: note?.kind ?? null, note: note?.note ?? null, note_by: note?.by_user ?? null, note_at: note?.created_at ?? null,
        last_activity_at: times.length ? new Date(Math.max(...times)) : null,
      };
    })
    .sort((a, b) => a.pid - b.pid);

  const run = async (text: string, params: any[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    db.statements.push(sql);
    if (db.failOn && db.failOn.test(sql)) throw db.failWith ?? new Error('disk on fire');
    const s = db.state;
    if (sql === 'BEGIN') { db.snapshot = clone(s); return result(); }
    if (sql === 'COMMIT') { db.snapshot = null; return result(); }
    if (sql === 'ROLLBACK') { if (db.snapshot) db.state = db.snapshot; db.snapshot = null; return result(); }
    if (sql === 'SELECT project_name FROM projects WHERE TRIM(id) = $1') {
      return result(s.projects.filter((p) => String(p.id).trim() === params[0]).map((p) => ({ project_name: p.project_name })));
    }
    if (sql === 'SELECT id, name, position FROM project_stages ORDER BY position, id') {
      return result([...s.stages].sort((a, b) => a.position - b.position || a.id - b.id).map((r) => ({ ...r })));
    }
    if (sql.startsWith('WITH p AS (')) return result(boardRows());
    if (sql === 'SELECT id, name FROM project_stages WHERE id = $1 FOR SHARE') {
      return result(s.stages.filter((r) => r.id === params[0]).map(({ id, name }) => ({ id, name })));
    }
    if (sql === 'SELECT pp.stage_id, s.name AS stage_name FROM project_progress pp LEFT JOIN project_stages s ON s.id = pp.stage_id WHERE pp.project_id = $1 FOR UPDATE OF pp') {
      const row = progressOf(params[0]);
      return result(row ? [{ stage_id: row.stage_id, stage_name: s.stages.find((st) => st.id === row.stage_id)?.name ?? null }] : []);
    }
    if (sql.startsWith('INSERT INTO project_progress (project_id, stage_id, stage_since, stage_by, updated_at) VALUES ($1, $2, now(), $3, now()) ON CONFLICT (project_id) DO UPDATE SET stage_id = EXCLUDED.stage_id')) {
      if (!s.stages.some((st) => st.id === params[1])) throw fkError();
      const at = now();
      upsertProgress(params[0], { stage_id: params[1], stage_since: at, stage_by: params[2], updated_at: at });
      return result([], 1);
    }
    if (sql === 'SELECT on_hold FROM project_progress WHERE project_id = $1 FOR UPDATE') {
      const row = progressOf(params[0]);
      return result(row ? [{ on_hold: row.on_hold }] : []);
    }
    if (sql.startsWith('INSERT INTO project_progress (project_id, on_hold, hold_reason, hold_since, hold_by, updated_at) VALUES ($1, TRUE, $2, now(), $3, now()) ON CONFLICT (project_id) DO UPDATE SET on_hold = TRUE')) {
      const at = now();
      upsertProgress(params[0], { on_hold: true, hold_reason: params[1], hold_since: at, hold_by: params[2], updated_at: at });
      return result([], 1);
    }
    if (sql === 'UPDATE project_progress SET on_hold = FALSE, hold_reason = NULL, hold_since = NULL, hold_by = NULL, updated_at = now() WHERE project_id = $1') {
      const row = progressOf(params[0]);
      if (row) Object.assign(row, { on_hold: false, hold_reason: null, hold_since: null, hold_by: null, updated_at: now() });
      return result([], row ? 1 : 0);
    }
    if (sql === 'INSERT INTO project_progress (project_id, updated_at) VALUES ($1, now()) ON CONFLICT (project_id) DO UPDATE SET updated_at = now()') {
      upsertProgress(params[0], { updated_at: now() });
      return result([], 1);
    }
    if (sql === 'INSERT INTO project_progress_log (project_id, kind, from_stage, to_stage, note, by_user) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, kind, from_stage, to_stage, note, by_user, created_at') {
      const [project_id, kind, from_stage, to_stage, note, by_user] = params;
      const row = { id: db.nextLogId++, project_id, kind, from_stage, to_stage, note, by_user, created_at: now() };
      s.log.push(row);
      const { project_id: _p, ...returned } = row;
      return result([returned]);
    }
    if (sql === "INSERT INTO user_activity_logs (user_email, action, entity_type, entity_id, details, status) VALUES ($1, $2, $3, $4, $5, 'SUCCESS')") {
      const [user_email, action, entity_type, entity_id, details] = params;
      s.activity.push({ user_email, action, entity_type, entity_id, details: JSON.parse(details) });
      return result([], 1);
    }
    if (sql === 'SELECT id, kind, from_stage, to_stage, note, by_user, created_at FROM project_progress_log WHERE project_id = $1 ORDER BY created_at DESC, id DESC LIMIT 500') {
      return result(s.log.filter((l) => l.project_id === params[0]).sort((a, b) => +b.created_at - +a.created_at || b.id - a.id).map(({ project_id: _p, ...r }) => r));
    }
    if (sql === 'LOCK TABLE project_stages IN EXCLUSIVE MODE') return result();
    if (sql === 'SELECT stage_id, COUNT(*)::int AS n FROM project_progress WHERE stage_id = ANY($1::int[]) GROUP BY stage_id ORDER BY stage_id') {
      const counts = new Map<number, number>();
      for (const r of s.progress) if (params[0].includes(r.stage_id)) counts.set(r.stage_id, (counts.get(r.stage_id) ?? 0) + 1);
      return result([...counts].sort((a, b) => a[0] - b[0]).map(([stage_id, n]) => ({ stage_id, n })));
    }
    if (sql === 'DELETE FROM project_stages WHERE id = ANY($1::int[])') {
      if (s.progress.some((r) => params[0].includes(r.stage_id))) throw fkError();
      const before = s.stages.length;
      s.stages = s.stages.filter((r) => !params[0].includes(r.id));
      return result([], before - s.stages.length);
    }
    if (sql === "UPDATE project_stages SET name = E'\\n' || id::text WHERE id = ANY($1::int[])") {
      for (const r of s.stages) if (params[0].includes(r.id)) r.name = `\n${r.id}`;
      uniqueNames();
      return result([], params[0].length);
    }
    if (sql === 'UPDATE project_stages SET name = $2, position = $3 WHERE id = $1') {
      const row = s.stages.find((r) => r.id === params[0]);
      if (row) Object.assign(row, { name: params[1], position: params[2] });
      uniqueNames();
      return result([], row ? 1 : 0);
    }
    if (sql === 'INSERT INTO project_stages (name, position) VALUES ($1, $2)') {
      s.stages.push({ id: db.nextStageId++, name: params[0], position: params[1] });
      uniqueNames();
      return result([], 1);
    }
    // The project delete cascade (projectsRoutes).
    if (sql === 'DELETE FROM projects WHERE id = $1') {
      const before = s.projects.length;
      s.projects = s.projects.filter((p) => Number(p.id) !== params[0]);
      return result([], before - s.projects.length);
    }
    if (/^DROP TABLE IF EXISTS "(db|pp)_bom_project_\d+"$/.test(sql)) return result();
    if (sql === 'DELETE FROM job_cards WHERE project_id = $1') { s.jobCards = s.jobCards.filter((j) => j.project_id !== params[0]); return result(); }
    if (sql === 'DELETE FROM project_progress WHERE project_id = $1') { s.progress = s.progress.filter((r) => r.project_id !== params[0]); return result(); }
    if (sql === 'DELETE FROM project_progress_log WHERE project_id = $1') { s.log = s.log.filter((r) => r.project_id !== params[0]); return result(); }
    throw new Error(`unexpected SQL in test: ${sql}`);
  };
  return {
    pool: { connect: async () => ({ query: run, release: () => { db.released += 1; } }) },
    query: run,
    queryOne: async (text: string, params: any[] = []) => (await run(text, params)).rows[0] ?? null,
    exec: async (text: string) => { await run(text); },
  };
});

import { ensureProjectProgressSchema, registerProjectProgressRoutes } from './projectProgress';
import { registerProjectsRoutes } from './projectsRoutes';

const at = (iso: string) => new Date(iso);
const STAGES = ['Planning', 'Design & BOM', 'Sourcing', 'Kitting', 'Assembly', 'Testing', 'Complete'];

function freshState(): State {
  return {
    stages: STAGES.map((name, i) => ({ id: i + 1, name, position: i })),
    projects: [
      { id: '1', project_name: 'TCU06 PCB', status: 'ACTIVE', assigned_team: null, start_date: null, end_date: '2026-10-01', updated_at: at('2026-09-16T08:01:14Z') },
      { id: '60', project_name: 'NCU05', status: 'Active', assigned_team: '', start_date: '2026-07-28', end_date: null, updated_at: at('2026-10-06T04:01:56Z') },
      { id: '62', project_name: 'POWER PACK', status: 'Inactive', assigned_team: 'Line B', start_date: null, end_date: null, updated_at: at('2026-09-29T05:19:09Z') },
      { id: 'x9', project_name: 'Imported oddity', status: 'Active', assigned_team: null, start_date: null, end_date: null, updated_at: at('2026-01-01T00:00:00Z') },
    ],
    progress: [
      { project_id: 60, stage_id: 5, stage_since: at('2026-09-20T09:00:00Z'), stage_by: 'dylan@example.com', on_hold: false, hold_reason: null, hold_since: null, hold_by: null, updated_at: at('2026-09-20T09:00:00Z') },
    ],
    log: [
      { id: 1, project_id: 60, kind: 'stage', from_stage: 'Kitting', to_stage: 'Assembly', note: 'Kits picked', by_user: 'dylan@example.com', created_at: at('2026-09-20T09:00:00Z') },
    ],
    activity: [],
    kits: [
      { project_id: 1, updated_at: at('2026-09-16T11:11:16Z') },
      { project_id: 1, updated_at: at('2026-09-10T10:00:00Z') },
      { project_id: 63, updated_at: at('2026-09-17T05:05:04Z') },
    ],
    jobCards: [
      { project_id: 60, status: 'In Progress', build_qty: 1 },
      { project_id: 60, status: 'In Progress', build_qty: 2 },
      { project_id: 60, status: 'Pending', build_qty: 0 },
      { project_id: 1, status: 'Completed', build_qty: 5 },
    ],
  };
}

let server: Server;
let base = '';
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Stands in for attachSessionUser: the role and email come from headers here.
  app.use((req: any, _res, next) => {
    const role = req.header('x-role');
    if (role) req.user = { id: 1, email: `${role}@example.com`, role };
    next();
  });
  registerProjectProgressRoutes(app);
  registerProjectsRoutes(app);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));

beforeEach(() => {
  db.state = freshState();
  db.snapshot = null;
  db.statements = [];
  db.failOn = null;
  db.failWith = null;
  db.ticks = 0;
  db.nextStageId = 100;
  db.nextLogId = 100;
  db.released = 0;
});

const call = async (method: string, path: string, body?: unknown, role: string | null = 'engineer') => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (role) headers['x-role'] = role;
  const r = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const board = async (role = 'engineer') => (await call('GET', '/api/project-progress', undefined, role)).body;
const project = async (id: number) => (await board()).projects.find((p: any) => p.id === id);

describe('ensureProjectProgressSchema', () => {
  it('creates the tables and adds the default stages only to an empty list', async () => {
    const sent: string[] = [];
    await ensureProjectProgressSchema(async (sql) => { sent.push(sql.replace(/\s+/g, ' ')); });
    expect(sent.filter((s) => s.startsWith('CREATE TABLE IF NOT EXISTS')).map((s) => s.split(' ')[5])).toEqual(['project_stages', 'project_progress', 'project_progress_log']);
    const seed = sent.find((s) => s.startsWith('INSERT INTO project_stages'))!;
    expect(seed).toContain("('Planning', 0), ('Design & BOM', 1)");
    expect(seed).toContain("('Complete', 6)");
    expect(seed).toContain('WHERE NOT EXISTS (SELECT 1 FROM project_stages) ON CONFLICT DO NOTHING');
    expect(sent).toContain('CREATE UNIQUE INDEX IF NOT EXISTS project_stages_name_key ON project_stages (lower(name))');
  });
});

describe('GET /api/project-progress', () => {
  it('lists the stages in order and every project in its stage', async () => {
    db.state.stages.reverse(); // stored order doesn't matter, position does
    const body = await board();
    expect(body.stages.map((s: any) => s.name)).toEqual(STAGES);
    expect(body.projects.map((p: any) => p.id)).toEqual([1, 60, 62]); // "x9" isn't a number: left out
    const [tcu, ncu, pack] = body.projects;
    expect(tcu).toMatchObject({
      name: 'TCU06 PCB', status: 'ACTIVE', team: null, endDate: '2026-10-01',
      stageId: 1, stageSet: false, stageSince: null, onHold: false, lastNote: null,
      kits: { count: 2, lastSavedAt: '2026-09-16T11:11:16.000Z' },
      builds: { inProgress: 0, inProgressQty: 0, completed: 1 },
      lastActivityAt: '2026-09-16T11:11:16.000Z',
    });
    expect(ncu).toMatchObject({
      name: 'NCU05', team: null, stageId: 5, stageSet: true, stageSince: '2026-09-20T09:00:00.000Z', stageBy: 'dylan@example.com',
      lastNote: { kind: 'stage', note: 'Kits picked', by: 'dylan@example.com', at: '2026-09-20T09:00:00.000Z' },
      kits: { count: 0, lastSavedAt: null },
      builds: { inProgress: 2, inProgressQty: 3, completed: 0 },
      lastActivityAt: '2026-10-06T04:01:56.000Z',
    });
    expect(pack).toMatchObject({ status: 'Inactive', team: 'Line B', stageId: 1, stageSet: false });
  });

  it('says what the caller may do', async () => {
    expect((await board('viewer')).can).toEqual({ move: false, editStages: false });
    expect((await board('engineer')).can).toEqual({ move: true, editStages: false });
    expect((await board('manager')).can).toEqual({ move: true, editStages: false });
    expect((await board('admin')).can).toEqual({ move: true, editStages: true });
  });
});

describe('moving a project', () => {
  it('moves it, records who moved it and why, and writes the activity log', async () => {
    const res = await call('POST', '/api/project-progress/60/stage', { stageId: 6, note: '  Boards assembled ' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      projectId: 60, stageId: 6, stageName: 'Testing',
      entry: { kind: 'stage', fromStage: 'Assembly', toStage: 'Testing', note: 'Boards assembled', by: 'engineer@example.com' },
    });
    expect(await project(60)).toMatchObject({ stageId: 6, stageSet: true, stageBy: 'engineer@example.com', lastNote: { note: 'Boards assembled' } });
    expect(db.state.activity).toEqual([{
      user_email: 'engineer@example.com', action: 'MOVE_PROJECT_STAGE', entity_type: 'Project', entity_id: '60',
      details: { project: 'NCU05', from: 'Assembly', to: 'Testing', note: 'Boards assembled' },
    }]);
    expect(db.statements).toContain('COMMIT');
    expect(db.released).toBe(1);
  });

  it('places a project that never had a stage, even in the first stage', async () => {
    const res = await call('POST', '/api/project-progress/1/stage', { stageId: 1 });
    expect(res.status).toBe(200);
    expect(res.body.entry).toMatchObject({ fromStage: null, toStage: 'Planning', note: null });
    expect(await project(1)).toMatchObject({ stageId: 1, stageSet: true });
    // and then it is in that stage
    expect(await call('POST', '/api/project-progress/1/stage', { stageId: 1 })).toEqual({ status: 409, body: { error: 'TCU06 PCB is already in Planning.' } });
  });

  it('refuses a move to the stage it is already in, and writes nothing', async () => {
    const res = await call('POST', '/api/project-progress/60/stage', { stageId: 5 });
    expect(res).toEqual({ status: 409, body: { error: 'NCU05 is already in Assembly.' } });
    expect(db.state.log).toHaveLength(1);
    expect(db.statements).toContain('ROLLBACK');
    expect(db.released).toBe(1);
  });

  it('refuses a stage or a project that has gone', async () => {
    expect(await call('POST', '/api/project-progress/60/stage', { stageId: 99 }))
      .toEqual({ status: 409, body: { error: 'That stage has been removed. Reload the board and try again.' } });
    expect(await call('POST', '/api/project-progress/5/stage', { stageId: 2 }))
      .toEqual({ status: 404, body: { error: 'That project no longer exists.' } });
  });

  it('checks the request', async () => {
    expect(await call('POST', '/api/project-progress/abc/stage', { stageId: 2 })).toEqual({ status: 400, body: { error: 'That is not a project id.' } });
    expect(await call('POST', '/api/project-progress/0/stage', { stageId: 2 })).toEqual({ status: 400, body: { error: 'That is not a project id.' } });
    expect((await call('POST', '/api/project-progress/60/stage', {})).status).toBe(400);
    expect((await call('POST', '/api/project-progress/60/stage', { stageId: 'x' })).body).toEqual({ error: 'Say which stage (stageId) to move the project to.' });
    expect(db.statements).toEqual([]);
  });

  it('needs a role that may update projects', async () => {
    expect(await call('POST', '/api/project-progress/60/stage', { stageId: 6 }, 'viewer')).toEqual({
      status: 403, body: { error: 'Only admins, managers and engineers can change projects, project progress and production.' },
    });
    expect(await call('POST', '/api/project-progress/60/stage', { stageId: 6 }, null)).toEqual({ status: 401, body: { error: 'Sign in required' } });
    expect((await call('POST', '/api/project-progress/60/stage', { stageId: 6 }, 'manager')).status).toBe(200);
    expect((await call('POST', '/api/project-progress/60/stage', { stageId: 7 }, 'admin')).status).toBe(200);
  });

  it('undoes the move when recording it fails', async () => {
    db.failOn = /^INSERT INTO project_progress_log/;
    const res = await call('POST', '/api/project-progress/60/stage', { stageId: 6 });
    expect(res.status).toBe(500);
    expect(db.state.progress.find((r) => r.project_id === 60)?.stage_id).toBe(5);
    expect(db.statements).toContain('ROLLBACK');
    expect(db.released).toBe(1);
  });

  it("still moves the project when the activity log can't be written", async () => {
    db.failOn = /user_activity_logs/;
    expect((await call('POST', '/api/project-progress/60/stage', { stageId: 6 })).status).toBe(200);
    expect(db.state.progress.find((r) => r.project_id === 60)?.stage_id).toBe(6);
  });

  it('asks for a reload when a stage went while saving', async () => {
    db.failOn = /^INSERT INTO project_progress \(project_id, stage_id/;
    db.failWith = Object.assign(new Error('violates foreign key constraint'), { code: '23503' });
    expect(await call('POST', '/api/project-progress/60/stage', { stageId: 6 }))
      .toEqual({ status: 409, body: { error: 'The stages changed while saving. Reload the board and try again.' } });
  });
});

describe('holds and updates', () => {
  it('puts a project on hold with the reason, and resumes it', async () => {
    const held = await call('POST', '/api/project-progress/1/hold', { onHold: true, reason: ' Waiting for PCBs ' });
    expect(held.status).toBe(200);
    expect(held.body).toMatchObject({ projectId: 1, onHold: true, entry: { kind: 'hold', note: 'Waiting for PCBs', by: 'engineer@example.com' } });
    // On hold, and still without a stage of its own.
    expect(await project(1)).toMatchObject({ onHold: true, holdReason: 'Waiting for PCBs', holdBy: 'engineer@example.com', stageId: 1, stageSet: false });
    expect(await call('POST', '/api/project-progress/1/hold', { onHold: true })).toEqual({ status: 409, body: { error: 'TCU06 PCB is already on hold.' } });

    const resumed = await call('POST', '/api/project-progress/1/hold', { onHold: false, reason: 'PCBs arrived' });
    expect(resumed.body).toMatchObject({ onHold: false, entry: { kind: 'resume', note: 'PCBs arrived' } });
    expect(await project(1)).toMatchObject({ onHold: false, holdReason: null, holdSince: null, holdBy: null });
    expect(await call('POST', '/api/project-progress/1/hold', { onHold: false })).toEqual({ status: 409, body: { error: "TCU06 PCB isn't on hold." } });
    expect(db.state.activity.map((a) => a.action)).toEqual(['HOLD_PROJECT', 'RESUME_PROJECT']);
  });

  it('needs onHold to be true or false', async () => {
    expect(await call('POST', '/api/project-progress/1/hold', { onHold: 'yes' })).toEqual({ status: 400, body: { error: 'onHold must be true or false.' } });
    expect((await call('POST', '/api/project-progress/1/hold', { onHold: true }, 'viewer')).status).toBe(403);
  });

  it('adds updates, and shows them newest first', async () => {
    expect(await call('POST', '/api/project-progress/60/update', { note: '   ' })).toEqual({ status: 400, body: { error: 'Write the update first.' } });
    const res = await call('POST', '/api/project-progress/60/update', { note: 'Stencil ordered' });
    expect(res.body).toMatchObject({ projectId: 60, entry: { kind: 'update', note: 'Stencil ordered', fromStage: null, toStage: null } });
    const history = await call('GET', '/api/project-progress/60/history');
    expect(history.body.entries.map((e: any) => [e.kind, e.note])).toEqual([['update', 'Stencil ordered'], ['stage', 'Kits picked']]);
    expect(await project(60)).toMatchObject({ lastNote: { kind: 'update', note: 'Stencil ordered', by: 'engineer@example.com' } });
    expect(db.state.activity.map((a) => a.action)).toEqual(['ADD_PROJECT_UPDATE']);
  });

  it('has no history for a project that does not exist', async () => {
    expect(await call('GET', '/api/project-progress/5/history')).toEqual({ status: 404, body: { error: 'That project no longer exists.' } });
    expect(await call('GET', '/api/project-progress/abc/history')).toEqual({ status: 400, body: { error: 'That is not a project id.' } });
  });
});

describe('PUT /api/project-progress/stages', () => {
  const list = () => [...db.state.stages].sort((a, b) => a.position - b.position).map((s) => [s.id, s.name]);
  const keep = (over: Record<number, string> = {}) => STAGES.map((name, i) => ({ id: i + 1, name: over[i + 1] ?? name }));

  it('is for admins', async () => {
    expect(await call('PUT', '/api/project-progress/stages', { stages: keep() }, 'engineer'))
      .toEqual({ status: 403, body: { error: 'Only admins can change settings.' } });
  });

  it('renames, reorders and adds stages, and two stages can swap names', async () => {
    const stages = keep({ 1: 'Design & BOM', 2: 'Planning' });
    stages.splice(3, 0, { id: null as any, name: 'Ordering' });
    const res = await call('PUT', '/api/project-progress/stages', { stages }, 'admin');
    expect(res.status).toBe(200);
    expect(res.body.stages.map((s: any) => [s.id, s.name, s.position])).toEqual([
      [1, 'Design & BOM', 0], [2, 'Planning', 1], [3, 'Sourcing', 2], [100, 'Ordering', 3],
      [4, 'Kitting', 4], [5, 'Assembly', 5], [6, 'Testing', 6], [7, 'Complete', 7],
    ]);
    // The project in Assembly stays there.
    expect(await project(60)).toMatchObject({ stageId: 5 });
    expect(db.state.activity).toEqual([expect.objectContaining({
      action: 'EDIT_PROJECT_STAGES', entity_type: 'ProjectStages', entity_id: null,
      details: { before: STAGES, after: ['Design & BOM', 'Planning', 'Sourcing', 'Ordering', 'Kitting', 'Assembly', 'Testing', 'Complete'] },
    })]);
  });

  it("won't remove a stage that has projects in it", async () => {
    const res = await call('PUT', '/api/project-progress/stages', { stages: keep().filter((s) => s.id !== 5) }, 'admin');
    expect(res).toEqual({ status: 409, body: { error: 'Move the projects out of Assembly (1 project) before removing it.' } });
    expect(list()).toEqual(STAGES.map((name, i) => [i + 1, name]));
    expect(db.statements).toContain('ROLLBACK');
  });

  it('removes an empty stage', async () => {
    const res = await call('PUT', '/api/project-progress/stages', { stages: keep().filter((s) => s.id !== 4) }, 'admin');
    expect(res.status).toBe(200);
    expect(list().map(([, name]) => name)).toEqual(['Planning', 'Design & BOM', 'Sourcing', 'Assembly', 'Testing', 'Complete']);
    expect(db.state.stages.map((s) => s.position).sort()).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('checks the list', async () => {
    expect(await call('PUT', '/api/project-progress/stages', { stages: [...keep(), { name: 'planning' }] }, 'admin'))
      .toEqual({ status: 400, body: { error: '"planning" is in the list twice.' } });
    expect(await call('PUT', '/api/project-progress/stages', { stages: [{ id: 1, name: 'A' }, { id: 42, name: 'B' }] }, 'admin'))
      .toEqual({ status: 400, body: { error: 'Stage "B" no longer exists. Reload and try again.' } });
    expect(await call('PUT', '/api/project-progress/stages', {}, 'admin')).toEqual({ status: 400, body: { error: 'Send the stages as a list.' } });
    expect(list()).toEqual(STAGES.map((name, i) => [i + 1, name]));
  });
});

describe('deleting a project', () => {
  it('deletes its progress too, so a new project given the same id starts afresh', async () => {
    expect((await call('DELETE', '/api/projects/60')).status).toBe(200);
    expect(db.state.progress.some((r) => r.project_id === 60)).toBe(false);
    expect(db.state.log.some((r) => r.project_id === 60)).toBe(false);
  });
});
