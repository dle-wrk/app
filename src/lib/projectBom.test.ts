// @vitest-environment node
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The real BOM Manager endpoints (GET/POST /api/projects/:id/bom and POST
// /api/projects/:id/pp) on a real Express app, against a small in-memory
// stand-in for Postgres. The stand-in keeps tables as arrays of rows, runs
// BEGIN/COMMIT/ROLLBACK as snapshots, enforces the pick-and-place table's
// primary key, and has no unique key on the BOM tables, which is how the
// live ones are (server boot drops it). Any SQL it doesn't recognise fails
// the test, so ON CONFLICT upserts can't creep back in.

type Row = Record<string, any>;
const db = vi.hoisted(() => ({
  projects: new Set<number>(),
  tables: new Map<string, Row[]>(),
  snapshot: null as null | Map<string, Row[]>,
  statements: [] as string[],
  failOn: null as RegExp | null,
  released: 0,
}));

vi.mock('./db', () => {
  const copy = (m: Map<string, Row[]>) => new Map([...m].map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]));
  const result = (rows: Row[] = [], rowCount = rows.length) => ({ rows, rowCount });
  const run = async (text: string, params: any[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    db.statements.push(sql);
    if (db.failOn && db.failOn.test(sql)) throw new Error('disk on fire');
    let m: RegExpMatchArray | null;
    if (sql === 'BEGIN') { db.snapshot = copy(db.tables); return result(); }
    if (sql === 'COMMIT') { db.snapshot = null; return result(); }
    if (sql === 'ROLLBACK') { if (db.snapshot) db.tables = db.snapshot; db.snapshot = null; return result(); }
    if (sql === 'SELECT id FROM projects WHERE id::int = $1') return result(db.projects.has(params[0]) ? [{ id: String(params[0]) }] : []);
    if ((m = sql.match(/^CREATE TABLE IF NOT EXISTS "(\w+)"/))) { if (!db.tables.has(m[1])) db.tables.set(m[1], []); return result(); }
    if (/^ALTER TABLE "\w+" ADD COLUMN IF NOT EXISTS \w+ TEXT DEFAULT ''$/.test(sql)) return result();
    if ((m = sql.match(/^SELECT \* FROM "(\w+)" ORDER BY ctid$/))) {
      const rows = db.tables.get(m[1]);
      if (!rows) throw Object.assign(new Error(`relation "${m[1]}" does not exist`), { code: '42P01' });
      return result(rows.map((r) => ({ ...r })));
    }
    if ((m = sql.match(/^DELETE FROM "(\w+)" WHERE TRIM\(internal_stock_number\) = \$1$/))) {
      const rows = db.tables.get(m[1])!; const keep = rows.filter((r) => String(r.internal_stock_number).trim() !== params[0]);
      db.tables.set(m[1], keep); return result([], rows.length - keep.length);
    }
    if ((m = sql.match(/^INSERT INTO "(\w+)" \(project_name, internal_stock_number, qty_per_unit, ref_des, description, comment, footprint, libref\) VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8\)$/))) {
      const [project_name, internal_stock_number, qty_per_unit, ref_des, description, comment, footprint, libref] = params;
      db.tables.get(m[1])!.push({ project_name, internal_stock_number, qty_per_unit, ref_des, description, comment, footprint, libref });
      return result([], 1);
    }
    if ((m = sql.match(/^DELETE FROM "(\w+)"$/))) { const n = db.tables.get(m[1])!.length; db.tables.set(m[1], []); return result([], n); }
    if ((m = sql.match(/^DELETE FROM "(\w+)" WHERE stock_code = ANY\(\$1::text\[\]\)$/))) {
      const rows = db.tables.get(m[1])!; const keep = rows.filter((r) => !params[0].includes(r.stock_code));
      db.tables.set(m[1], keep); return result([], rows.length - keep.length);
    }
    if ((m = sql.match(/^INSERT INTO "(\w+)" \(project_name, stock_code, comment, description, designator, footprint, libref, quantity\) VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8\)$/))) {
      const rows = db.tables.get(m[1])!;
      // The pick-and-place tables do have a primary key on stock_code.
      if (rows.some((r) => r.stock_code === params[1])) throw new Error(`duplicate key value violates unique constraint "${m[1]}_pkey"`);
      const [project_name, stock_code, comment, description, designator, footprint, libref, quantity] = params;
      rows.push({ project_name, stock_code, comment, description, designator, footprint, libref, quantity });
      return result([], 1);
    }
    if (/^UPDATE production_kits SET status = 'STAGING', lastUpdated = \$1 WHERE projectId = \$2$/.test(sql)) return result();
    if (sql === 'UPDATE projects SET updated_at = now() WHERE id::int = $1') return result();
    throw new Error(`unexpected SQL in test: ${sql}`);
  };
  return {
    pool: { connect: async () => ({ query: run, release: () => { db.released += 1; } }) },
    query: run,
    queryOne: async (text: string, params: any[] = []) => (await run(text, params)).rows[0] ?? null,
    exec: async (text: string) => { await run(text); },
  };
});

import { foldBomRows, parseBomLines, registerProjectsRoutes } from './projectsRoutes';

let server: Server;
let base = '';
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  registerProjectsRoutes(app);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));

beforeEach(() => {
  db.projects = new Set([60, 1]);
  db.tables = new Map();
  db.snapshot = null;
  db.statements = [];
  db.failOn = null;
  db.released = 0;
});

const bomRow = (sc: string, qty: number, des = '', comment = '', extra: Row = {}) =>
  ({ project_name: 60, internal_stock_number: sc, qty_per_unit: qty, ref_des: des, description: `${sc} desc`, comment, footprint: '', libref: '', ...extra });
const line = (stockCode: string, quantity: number, designator = '', comment = '') =>
  ({ stockCode, quantity, designator, comment, description: `${stockCode} desc`, footprint: '', libref: '' });

const getBom = async (id = 60) => { const r = await fetch(`${base}/api/projects/${id}/bom`); return { status: r.status, body: await r.json() }; };
const post = async (path: string, body: unknown) => {
  const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const table = (name: string) => db.tables.get(name)!.map(({ internal_stock_number, qty_per_unit, ref_des, comment }) => [internal_stock_number, qty_per_unit, ref_des, comment]);

describe('foldBomRows', () => {
  it('folds several rows for one part into a single line', () => {
    expect(foldBomRows([
      bomRow('CAP-024', 2, 'C1, C2', 'X7R'),
      bomRow('RES-001', 4, 'R1-R4'),
      bomRow('CAP-024', 1, 'C9', 'X7R'),
      bomRow('CAP-024', 1, '', 'check polarity'),
    ])).toEqual([
      { stockCode: 'CAP-024', quantity: 4, designator: 'C1, C2, C9', description: 'CAP-024 desc', comment: 'X7R; check polarity', footprint: '', libref: '' },
      { stockCode: 'RES-001', quantity: 4, designator: 'R1-R4', description: 'RES-001 desc', comment: '', footprint: '', libref: '' },
    ]);
  });

  it('counts a row with no quantity as 1 and ignores rows with no stock code', () => {
    expect(foldBomRows([bomRow(' ANT-001 ', null as any), bomRow('', 3)]).map((l) => [l.stockCode, l.quantity])).toEqual([['ANT-001', 1]]);
  });
});

describe('parseBomLines', () => {
  it.each([
    [undefined, 'items must be a list'],
    [[{ quantity: 1 }], 'every line needs a stock code'],
    [[line('A', 1), line('A', 2)], 'A is listed more than once'],
    [[line('A', -1)], 'A: quantity must be a whole number'],
    [[line('A', 1.5)], 'A: quantity must be a whole number'],
  ])('rejects %j', (items, error) => {
    expect(parseBomLines(items)).toEqual({ error });
  });
});

describe('GET /api/projects/:id/bom', () => {
  it('returns one line per part', async () => {
    db.tables.set('db_bom_project_60', [bomRow('CAP-024', 1, 'C1'), bomRow('CAP-024', 1, 'C2')]);

    const res = await getBom();

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ stockCode: 'CAP-024', quantity: 2, designator: 'C1, C2', description: 'CAP-024 desc', comment: '', footprint: '', libref: '' }]);
  });

  it('returns an empty BOM for a project that has none yet', async () => {
    expect(await getBom()).toEqual({ status: 200, body: [] });
  });
});

describe('POST /api/projects/:id/bom', () => {
  it('saves into a BOM table that has no unique key, which is what used to fail', async () => {
    db.tables.set('db_bom_project_60', [bomRow('ANT-001', 5, 'A1, A2', 'Test Comment')]);

    const res = await post('/api/projects/60/bom', { replace: true, items: [line('BUT-002', 2, 'S1, S2'), line('CAP-009', 1)] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, added: 2, updated: 0, removed: 1, unchanged: 0 });
    expect(table('db_bom_project_60')).toEqual([['BUT-002', 2, 'S1, S2', ''], ['CAP-009', 1, '', '']]);
    expect(db.statements.some((s) => /ON CONFLICT/i.test(s))).toBe(false);
  });

  it('keeps edits to quantity, designators and comments', async () => {
    db.tables.set('db_bom_project_60', [bomRow('BUT-002', 1), bomRow('CAP-009', 1)]);

    const res = await post('/api/projects/60/bom', { replace: true, items: [line('BUT-002', 2, 'S1, S2', 'tactile'), line('CAP-009', 1)] });

    expect(res.body).toMatchObject({ added: 0, updated: 1, removed: 0, unchanged: 1 });
    expect(table('db_bom_project_60')).toEqual([['CAP-009', 1, '', ''], ['BUT-002', 2, 'S1, S2', 'tactile']]);
  });

  it('leaves the rows of an unchanged part exactly as they were', async () => {
    db.tables.set('db_bom_project_60', [bomRow('CAP-024', 1, 'C1'), bomRow('LED-005', 1), bomRow('CAP-024', 1, 'C2')]);
    const before = db.tables.get('db_bom_project_60')!.filter((r) => r.internal_stock_number === 'CAP-024').map((r) => ({ ...r }));

    // CAP-024 comes back exactly as the GET folded it; only LED-005 changed.
    const res = await post('/api/projects/60/bom', { replace: true, items: [line('CAP-024', 2, 'C1, C2'), line('LED-005', 3, 'D1-D3')] });

    expect(res.body).toMatchObject({ updated: 1, unchanged: 1 });
    expect(db.tables.get('db_bom_project_60')!.filter((r) => r.internal_stock_number === 'CAP-024')).toEqual(before);
  });

  it('only removes parts that were left out when asked to replace the BOM', async () => {
    db.tables.set('db_bom_project_60', [bomRow('ANT-001', 5), bomRow('BUT-002', 1)]);

    const res = await post('/api/projects/60/bom', { items: [line('BUT-002', 2)] });

    expect(res.body).toMatchObject({ updated: 1, removed: 0 });
    expect(table('db_bom_project_60').map((r) => r[0])).toEqual(['ANT-001', 'BUT-002']);
  });

  it('creates the BOM table for a project that has none', async () => {
    const res = await post('/api/projects/60/bom', { replace: true, items: [line('BUT-002', 1)] });

    expect(res.body).toMatchObject({ added: 1 });
    expect(table('db_bom_project_60')).toEqual([['BUT-002', 1, '', '']]);
  });

  it('can empty a BOM when every part is removed', async () => {
    db.tables.set('db_bom_project_60', [bomRow('ANT-001', 5)]);

    const res = await post('/api/projects/60/bom', { replace: true, items: [] });

    expect(res.body).toMatchObject({ removed: 1 });
    expect(table('db_bom_project_60')).toEqual([]);
  });

  it('resets the project’s kits to STAGING only when something changed', async () => {
    db.tables.set('db_bom_project_60', [bomRow('BUT-002', 1)]);

    await post('/api/projects/60/bom', { replace: true, items: [line('BUT-002', 1)] });
    expect(db.statements.some((s) => s.startsWith('UPDATE production_kits'))).toBe(false);

    await post('/api/projects/60/bom', { replace: true, items: [line('BUT-002', 2)] });
    expect(db.statements.some((s) => s.startsWith('UPDATE production_kits'))).toBe(true);
    expect(db.statements.some((s) => s.startsWith('UPDATE projects SET updated_at'))).toBe(true);
  });

  it('answers 404 for a project that does not exist, and writes nothing', async () => {
    const res = await post('/api/projects/999/bom', { replace: true, items: [line('BUT-002', 1)] });

    expect(res.status).toBe(404);
    expect(db.tables.has('db_bom_project_999')).toBe(false);
    expect(db.released).toBe(1);
  });

  it('answers 400 for lines it cannot save', async () => {
    const res = await post('/api/projects/60/bom', { replace: true, items: [line('BUT-002', 1), line('BUT-002', 2)] });

    expect(res).toEqual({ status: 400, body: { error: 'BUT-002 is listed more than once' } });
    expect(db.statements).toEqual([]);
  });

  it('changes nothing if a write fails part-way', async () => {
    db.tables.set('db_bom_project_60', [bomRow('ANT-001', 5), bomRow('BUT-002', 1)]);
    db.failOn = /^INSERT INTO "db_bom_project_60"/;

    const res = await post('/api/projects/60/bom', { replace: true, items: [line('BUT-002', 2)] });

    expect(res.status).toBe(500);
    expect(table('db_bom_project_60')).toEqual([['ANT-001', 5, '', ''], ['BUT-002', 1, '', '']]);
    expect(db.statements.at(-1)).toBe('ROLLBACK');
    expect(db.released).toBe(1);
  });
});

describe('POST /api/projects/:id/pp', () => {
  const pp = () => db.tables.get('pp_bom_project_60')!.map((r) => [r.stock_code, r.quantity, r.designator]);
  const ppRow = (stock_code: string, quantity: number, designator = '') => ({ project_name: 60, stock_code, quantity, designator, comment: '', description: '', footprint: '', libref: '' });

  it('makes the list exactly the lines sent when asked to replace it', async () => {
    db.tables.set('pp_bom_project_60', [ppRow('ANT-001', 5, 'A1, A2'), ppRow('BUT-002', 1)]);

    const res = await post('/api/projects/60/pp', { replace: true, items: [line('BUT-002', 2, 'S1, S2'), line('CAP-009', 1)] });

    expect(res.body).toEqual({ ok: true, count: 2 });
    expect(pp()).toEqual([['BUT-002', 2, 'S1, S2'], ['CAP-009', 1, '']]);
  });

  it('otherwise updates the lines sent and keeps the rest', async () => {
    db.tables.set('pp_bom_project_60', [ppRow('ANT-001', 5), ppRow('BUT-002', 1)]);

    await post('/api/projects/60/pp', { items: [line('BUT-002', 2)] });

    expect(pp()).toEqual([['ANT-001', 5, ''], ['BUT-002', 2, '']]);
  });
});
