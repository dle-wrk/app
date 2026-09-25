// Shared "did anyone change X since we last looked?" counters. One row
// per named key in a small data_versions table. Every write path that
// wants to notify other tabs / users bumps its key here, and clients
// poll GET /api/data-versions (aggregate) or /api/data-version?key=X
// (single) to notice changes.
//
// Why not add `updated_at` to every entity table? Two reasons:
//   1. Zero write-path surgery on hundreds of route handlers — a bump
//      call is one line at the end of each handler.
//   2. One indexed row lookup per poll instead of a MAX(updated_at)
//      across a large table.
//
// Bumps are fire-and-forget: a failed bump never rolls back the
// underlying write. Worst case is one tab misses ONE tick and picks
// up the next change.

import type { Express, Request, Response, NextFunction } from 'express';
import { query, exec } from './db';

// The canonical set of keys clients know how to react to. Anything not
// in this list still works — the server accepts any string key — but
// wiring a new client-side subscriber typically means adding a name
// here first so future readers can trace it.
export const DATA_KEYS = [
  'inventory',       // items, item edits, imports, restores
  'clients',         // customer records
  'client_orders',   // sales orders + reservations
  'suppliers',       // supplier records
  'bookkeeping',     // invoices, bills, payments, POs, dispatch notes
  'projects',        // project catalogue
  'production_kits', // kit-booking saved kits
  'bom',             // BOM lines
  'pick_place',      // PP items
] as const;

export type DataKey = typeof DATA_KEYS[number] | string;

export async function ensureDataVersionsTable(): Promise<void> {
  await exec(`CREATE TABLE IF NOT EXISTS data_versions (
    key TEXT PRIMARY KEY,
    version BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`).catch(() => {});
  for (const key of DATA_KEYS) {
    await exec(
      `INSERT INTO data_versions (key, version) VALUES ('${key}', 0) ON CONFLICT DO NOTHING`
    ).catch(() => {});
  }
}

export async function bumpDataVersion(key: DataKey): Promise<void> {
  try {
    await query(
      `INSERT INTO data_versions (key, version, updated_at) VALUES ($1, 1, now())
       ON CONFLICT (key) DO UPDATE SET version = data_versions.version + 1, updated_at = now()`,
      [key]
    );
  } catch { /* silent — see file header */ }
}

export async function getAllVersions(): Promise<Record<string, number>> {
  const { rows } = await query<{ key: string; version: string }>(
    `SELECT key, version::text FROM data_versions`
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.key] = Number(r.version) || 0;
  return out;
}

// Global middleware that inspects every write (POST/PUT/PATCH/DELETE)
// against /api/*, picks the matching version-counter key from the
// route pattern, and bumps it on 2xx. Keeps bump logic in one place
// instead of scattering `void bumpDataVersion(...)` across a hundred
// route handlers. Skipping means no clients get notified — err on
// the side of a false bump rather than a missed one.
const RULES: Array<{ test: RegExp; key: DataKey }> = [
  { test: /^\/api\/items(\/|$)/, key: 'inventory' },
  { test: /^\/api\/inventory(\/|$)/, key: 'inventory' },
  { test: /^\/api\/clients(\/|$)/, key: 'clients' },
  { test: /^\/api\/client-orders(\/|$)/, key: 'client_orders' },
  { test: /^\/api\/client-order-items(\/|$)/, key: 'client_orders' },
  { test: /^\/api\/client-order-reservations(\/|$)/, key: 'client_orders' },
  { test: /^\/api\/suppliers(\/|$)/, key: 'suppliers' },
  { test: /^\/api\/(invoices|bills|purchase-orders|payments-received|payments-made|dispatch-notes|expenses|accounts|tax-rates|journal-entries)(\/|$)/, key: 'bookkeeping' },
  { test: /^\/api\/projects(\/|$)/, key: 'projects' },
  { test: /^\/api\/(production-kits|production-products|kits)(\/|$)/, key: 'production_kits' },
  { test: /^\/api\/bom(\/|$)/, key: 'bom' },
  { test: /^\/api\/bom-items(\/|$)/, key: 'bom' },
  { test: /^\/api\/(pick-place|pp)(\/|$)/, key: 'pick_place' },
];

export function attachDataVersionMiddleware(app: Express): void {
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    const rule = RULES.find(r => r.test.test(req.path));
    if (!rule) return next();
    res.on('finish', () => {
      if (res.statusCode < 400) void bumpDataVersion(rule.key);
    });
    next();
  });
}
