// The app's background jobs, as Automation > Scheduled Jobs shows them: what
// each does, when it runs, how its last run went, on/off, and Run now.
//
// A job is registered in code (server.ts) with what it runs; its row in
// scheduled_jobs (job_name = the job's key) holds whether it is on and its
// last run. A job that is off is skipped when its time comes; Run now still
// runs it. One run of a job at a time.

import { pool, exec } from './db';

export interface JobDef {
  key: string;
  name: string;
  description: string;
  /** When it runs, in words ("Daily at 08:00"). */
  schedule: string;
  cron: string;
  /** False where a job has its own page to run it from (bulk pricing). */
  runNow: boolean;
  /** Whether this server runs it on its schedule (the deployed one does; a local one doesn't). */
  scheduled: boolean;
}

type Run = () => Promise<string>;
const jobs = new Map<string, { def: JobDef; run: Run }>();
const running = new Set<string>();

export async function ensureScheduledJobsSchema(run: (sql: string) => Promise<void> = exec): Promise<void> {
  await run(`ALTER TABLE scheduled_jobs ADD COLUMN IF NOT EXISTS last_run_at TIMESTAMPTZ`);
  await run(`ALTER TABLE scheduled_jobs ADD COLUMN IF NOT EXISTS last_message TEXT`);
  await run(`ALTER TABLE scheduled_jobs ADD COLUMN IF NOT EXISTS last_by TEXT`);
  await run(`ALTER TABLE scheduled_jobs ADD COLUMN IF NOT EXISTS last_ms INTEGER`);
}

export function registerJob(def: JobDef, run: Run): void { jobs.set(def.key, { def, run }); }
export const jobDefs = (): JobDef[] => [...jobs.values()].map((j) => j.def);

/** Runs a job and records how it went. `by` is 'schedule' for its timed run (skipped while the job is off), else who pressed Run now. */
export async function runJob(key: string, by: string): Promise<{ status: 'SUCCESS' | 'FAILED' | 'SKIPPED'; message: string }> {
  const job = jobs.get(key);
  if (!job) throw Object.assign(new Error('No such job.'), { status: 404 });
  const { rows: [row] } = await pool.query(
    `INSERT INTO scheduled_jobs (job_name, job_type, schedule_type, cron_expression) VALUES ($1, $1, $2, $3)
     ON CONFLICT (job_name) DO UPDATE SET schedule_type = EXCLUDED.schedule_type, cron_expression = EXCLUDED.cron_expression RETURNING is_active`,
    [key, job.def.schedule, job.def.cron]);
  if (by === 'schedule' && row?.is_active === false) return { status: 'SKIPPED', message: 'Turned off.' };
  if (running.has(key)) return { status: 'SKIPPED', message: 'It is already running.' };
  running.add(key);
  const started = Date.now();
  let status: 'SUCCESS' | 'FAILED' = 'SUCCESS'; let message: string;
  try { message = await job.run(); } catch (err: any) { status = 'FAILED'; message = err?.message || String(err); } finally { running.delete(key); }
  const ms = Date.now() - started;
  await pool.query(`UPDATE scheduled_jobs SET last_run = now(), last_run_at = now(), last_status = $2, last_message = $3, last_by = $4, last_ms = $5 WHERE job_name = $1`,
    [key, status, message.slice(0, 1000), by, ms]).catch(() => {});
  await pool.query(`INSERT INTO event_log (event_type, entity_type, entity_id, action, user_id, status, error_message, details) VALUES ('JOB_RUN', 'SCHEDULED_JOB', $1, $2, $3, $4, $5, $6)`,
    [key, by === 'schedule' ? 'SCHEDULED' : 'BY_HAND', by, status, status === 'FAILED' ? message : null, JSON.stringify({ message, ms })]).catch(() => {});
  if (status === 'FAILED') console.error(`[JOB ${key}] failed:`, message);
  return { status, message };
}

/** Every job with its row: on/off and its last run. */
export async function listJobs() {
  const { rows } = await pool.query(`SELECT job_name, is_active, last_run_at, last_status, last_message, last_by, last_ms FROM scheduled_jobs`);
  const byKey = new Map(rows.map((r: any) => [r.job_name, r]));
  return jobDefs().map((d) => {
    const r: any = byKey.get(d.key);
    return { ...d, isActive: r ? r.is_active !== false : true, running: running.has(d.key), lastRunAt: r?.last_run_at ?? null, lastStatus: r?.last_status ?? null, lastMessage: r?.last_message ?? null, lastBy: r?.last_by ?? null, lastMs: r?.last_ms ?? null };
  });
}

export async function setJobActive(key: string, active: boolean) {
  const job = jobs.get(key);
  if (!job) throw Object.assign(new Error('No such job.'), { status: 404 });
  await pool.query(
    `INSERT INTO scheduled_jobs (job_name, job_type, schedule_type, cron_expression, is_active) VALUES ($1, $1, $2, $3, $4)
     ON CONFLICT (job_name) DO UPDATE SET is_active = EXCLUDED.is_active`, [key, job.def.schedule, job.def.cron, active]);
}
