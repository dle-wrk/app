// Automatic activity log: every change made through the API (POST, PUT,
// PATCH, DELETE), successful or not, is written to user_activity_logs with
// who, what, which record, the result (HTTP status and the error when it
// failed, including refusals), how long it took, and a summary of what was
// sent. Passwords, tokens and keys are hidden; uploaded files are recorded
// by size only. Sign-in and session calls (logged by authRoutes), the log
// itself and background heartbeats are left out. Reads are not logged.
// Mounted in server.ts ahead of the sign-in and permission checks, so
// refused and unauthenticated attempts are recorded too.

import type { NextFunction, Request, Response } from 'express';
import { exec, query } from './db';
import { clientIp } from './serverUtils';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The log's user column must be a real account, and was also required, so
 * an attempt by someone not signed in (or a sign-in with an unknown email)
 * couldn't be logged, and deleting a user with log entries failed (the
 * rule clears it on delete). It may now be empty; who it was goes in the details.
 */
export async function ensureAuditSchema(run: (sql: string) => Promise<void> = exec): Promise<void> {
  await run(`ALTER TABLE user_activity_logs ALTER COLUMN user_email DROP NOT NULL`);
}

/** SQL for a log entry's user: the account with that email, or empty when there is none. */
export const LOG_USER_SQL = (param: string) => `(SELECT email FROM users WHERE email = ${param})`;

/** Paths not logged here: logged elsewhere, the log itself, or background chatter. */
const SKIP: RegExp[] = [
  /^\/api\/activity-log$/,
  /^\/api\/login$/,
  /^\/api\/session(\/|$)/,
  /^\/api\/auth\//,
  /^\/api\/pricing\/oauth\//,
  /^\/api\/kits\/[^/]+\/presence$/,
];

export function shouldAudit(method: string, path: string): boolean {
  return WRITE_METHODS.has(method.toUpperCase()) && path.startsWith('/api/') && !SKIP.some((re) => re.test(path));
}

const VERB: Record<string, string> = { POST: 'CREATE', PUT: 'UPDATE', PATCH: 'UPDATE', DELETE: 'DELETE' };
const word = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');

/**
 * What a write was: an action name in the log's style (CREATE_INVOICES,
 * INVOICES_VOID), the area, and the record's id or code when the path has one.
 */
export function describeWrite(method: string, path: string): { action: string; entityType: string; entityId: string | null } {
  const parts = path.replace(/^\/api\//, '').split('/').filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
  const area = parts[0] ?? 'unknown';
  const rest = parts.slice(1);
  let id: string | null = null;
  let sub: string | null = null;
  if (rest.length >= 2) { id = rest[0]; sub = rest.slice(1).join('_'); }
  else if (rest.length === 1) { if (/\d/.test(rest[0])) id = rest[0]; else sub = rest[0]; }
  // "/api/potential-orders/from-invoice/7": the id is last.
  if (sub && /\d/.test(rest[rest.length - 1] ?? '') && !/\d/.test(rest[0] ?? '')) { id = rest[rest.length - 1]; sub = rest.slice(0, -1).join('_'); }
  const action = sub ? `${word(area)}_${word(sub)}` : `${VERB[method.toUpperCase()] ?? method.toUpperCase()}_${word(area)}`;
  return { action, entityType: area, entityId: id ? id.slice(0, 200) : null };
}

const SECRET_KEY = /pass(word)?|secret|token|api[_-]?key|authori[sz]ation|credential|cookie|otp|\bpin\b|cvv|card[_-]?number|private[_-]?key/i;
const FILE_KEY = /(^|_)(data|base64|file|image|blob|content|attachment|doc[_-]?data)$/i;

/** A copy safe to keep: secrets hidden, files as their size, long text cut, deep or big parts trimmed. */
export function redact(value: unknown, depth = 0, key = ''): unknown {
  if (value === null || value === undefined) return value;
  if (key && SECRET_KEY.test(key)) return '[hidden]';
  if (typeof value === 'string') {
    if (value.length > 2000 && (FILE_KEY.test(key) || /^[A-Za-z0-9+/=\s]+$/.test(value.slice(0, 2000)) || value.startsWith('data:'))) {
      return `[file, ${Math.round((value.length * 3) / 4 / 1024)} KB]`;
    }
    return value.length > 300 ? `${value.slice(0, 300)}… (${value.length} characters)` : value;
  }
  if (typeof value !== 'object') return value;
  if (depth >= 4) return '[…]';
  if (Array.isArray(value)) {
    const head = value.slice(0, 20).map((v) => redact(v, depth + 1));
    return value.length > 20 ? [...head, `(+${value.length - 20} more)`] : head;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 60)) out[k] = redact(v, depth + 1, k);
  return out;
}

const MAX_DETAILS = 8000;

/** The details stored with the entry, kept under MAX_DETAILS characters. */
export function auditDetails(input: { method: string; path: string; status: number; ms: number; body: unknown; query: unknown; error: string | null; actor?: string }) {
  const d: Record<string, unknown> = { source: 'auto', actor: input.actor, method: input.method, path: input.path, httpStatus: input.status, ms: input.ms };
  if (input.error) d.error = input.error.slice(0, 500);
  if (input.query && Object.keys(input.query as object).length) d.query = redact(input.query);
  if (input.body !== undefined && input.body !== null && !(typeof input.body === 'object' && !Object.keys(input.body as object).length)) d.sent = redact(input.body);
  let json = JSON.stringify(d);
  if (json.length > MAX_DETAILS) { d.sent = '[too large to keep]'; json = JSON.stringify(d); }
  return json;
}

type Insert = (sql: string, params: unknown[]) => Promise<unknown>;

/** Express middleware: records each write when its response has been sent. */
export function auditWrites(insert: Insert = query) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const path = `${req.baseUrl || ''}${req.path}`.replace(/\/+$/, '') || req.path;
    if (!shouldAudit(req.method, path)) { next(); return; }
    const started = Date.now();
    // Keep the error message the handler sends back.
    let error: string | null = null;
    const json = res.json.bind(res);
    res.json = ((body: any) => {
      if (res.statusCode >= 400 && body && typeof body === 'object') error = String(body.error ?? body.message ?? '') || null;
      return json(body);
    }) as typeof res.json;
    res.on('finish', () => {
      const status = res.statusCode;
      const { action, entityType, entityId } = describeWrite(req.method, path);
      const user = (req as any).user?.email || null;
      const details = auditDetails({ method: req.method, path, status, ms: Date.now() - started, body: (req as any).body, query: req.query, error: status >= 400 ? (error || `HTTP ${status}`) : null, actor: user ?? 'not signed in' });
      void insert(
        `INSERT INTO user_activity_logs (user_email, action, entity_type, entity_id, details, ip_address, user_agent, status) VALUES (${LOG_USER_SQL('$1')}, $2, $3, $4, $5, $6, $7, $8)`,
        [user, action, entityType, entityId, details, clientIp(req), String(req.headers['user-agent'] ?? '').slice(0, 500), status >= 400 ? 'ERROR' : 'SUCCESS'],
      ).catch((err: any) => console.warn('[audit] could not log', action, err?.message));
    });
    next();
  };
}
