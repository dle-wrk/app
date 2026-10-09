// @vitest-environment node
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/production-products/import on a real Express app, against an
// in-memory production_products table that knows the statements it sends.

type Row = Record<string, any>;
const db = vi.hoisted(() => ({ rows: [] as Row[], snapshot: null as Row[] | null, statements: [] as string[], failOn: null as RegExp | null, released: 0, nextId: 10 }));

vi.mock('./db', () => {
  const result = (rows: Row[] = [], rowCount = rows.length) => ({ rows, rowCount });
  const run = async (text: string, params: any[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    db.statements.push(sql);
    if (db.failOn?.test(sql)) throw new Error('disk on fire');
    if (sql === 'BEGIN') { db.snapshot = db.rows.map((r) => ({ ...r })); return result(); }
    if (sql === 'COMMIT') { db.snapshot = null; return result(); }
    if (sql === 'ROLLBACK') { if (db.snapshot) db.rows = db.snapshot; db.snapshot = null; return result(); }
    if (/^SELECT \* FROM production_products ORDER BY id( FOR UPDATE)?$/.test(sql)) return result(db.rows.map((r) => ({ ...r })));
    if (sql.startsWith('INSERT INTO production_products (model_number, description, category, production_cost, selling_price, notes) VALUES')) {
      const [model_number, description, category, production_cost, selling_price, notes] = params;
      db.rows.push({ id: db.nextId++, model_number, description, category, production_cost, selling_price, notes, currency: 'ZAR' });
      return result([], 1);
    }
    let m: RegExpMatchArray | null;
    if ((m = sql.match(/^UPDATE production_products SET (.+), updated_at = CURRENT_TIMESTAMP WHERE id = \$1$/))) {
      const row = db.rows.find((r) => r.id === params[0])!;
      for (const part of m[1].split(', ')) {
        const [, col, n] = part.match(/^(\w+) = \$(\d+)$/)!;
        row[col] = params[Number(n) - 1];
      }
      return result([], 1);
    }
    if (sql.startsWith('INSERT INTO user_activity_logs')) return result([], 1);
    throw new Error(`unexpected SQL in test: ${sql}`);
  };
  return {
    pool: { connect: async () => ({ query: run, release: () => { db.released += 1; } }) },
    query: run,
    queryOne: async (t: string, p: any[] = []) => (await run(t, p)).rows[0] ?? null,
    exec: async (t: string) => { await run(t); },
  };
});

import { registerProductionRoutes } from './productionRoutes';

let server: Server;
let base = '';
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  registerProductionRoutes(app);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));
beforeEach(() => {
  db.rows = [
    { id: 1, model_number: 'TCU-001-SAT', description: '24V Self Powered', category: 'TCU', production_cost: null, selling_price: '8827.89', notes: null, currency: 'ZAR' },
    { id: 2, model_number: 'PWR-PCK-001', description: 'Power Pack', category: 'Power', production_cost: '2127.43', selling_price: '4254.86', notes: 'box', currency: 'ZAR' },
  ];
  db.snapshot = null; db.statements = []; db.failOn = null; db.released = 0; db.nextId = 10;
});

const post = async (body: unknown) => {
  const r = await fetch(`${base}/api/production-products/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const ROWS = [
  { line: 2, modelNumber: 'TCU-001-SAT', productionCost: 5200 },
  { line: 3, modelNumber: 'PWR-PCK-001', sellingPrice: 4254.86 },
  { line: 4, modelNumber: 'DON-004-SATD', description: 'New dongle', category: 'Dongle', sellingPrice: 900 },
];

describe('POST /api/production-products/import', () => {
  it('previews without writing anything', async () => {
    const before = JSON.stringify(db.rows);
    const res = await post({ rows: ROWS });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ applied: false, added: 1, updated: 1, unchanged: 1 });
    expect(res.body.changes.map((c: any) => [c.modelNumber, c.kind])).toEqual([['TCU-001-SAT', 'changed'], ['PWR-PCK-001', 'unchanged'], ['DON-004-SATD', 'new']]);
    expect(JSON.stringify(db.rows)).toBe(before);
    expect(db.statements).toContain('ROLLBACK');
    expect(db.statements.some((s) => /^(INSERT|UPDATE)/.test(s))).toBe(false);
  });

  it('applies in one transaction: adds the new, updates only the filled-in fields', async () => {
    const res = await post({ rows: ROWS, apply: true });
    expect(res.body).toMatchObject({ applied: true, added: 1, updated: 1, unchanged: 1 });
    expect(db.rows.find((r) => r.id === 1)).toMatchObject({ production_cost: 5200, selling_price: '8827.89', description: '24V Self Powered' });
    expect(db.rows.find((r) => r.model_number === 'DON-004-SATD')).toMatchObject({ description: 'New dongle', category: 'Dongle', selling_price: 900, production_cost: null });
    expect(db.statements.filter((s) => s.startsWith('UPDATE'))).toEqual(['UPDATE production_products SET production_cost = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1']);
    expect(db.statements).toContain('COMMIT');
    expect(db.released).toBe(1);
  });

  it('changes nothing when part of it fails', async () => {
    db.failOn = /^INSERT INTO production_products/;
    const before = JSON.stringify(db.rows);
    expect((await post({ rows: ROWS, apply: true })).status).toBe(500);
    expect(JSON.stringify(db.rows)).toBe(before);
  });

  it('refuses rows it cannot import', async () => {
    expect((await post({ rows: [] })).status).toBe(400);
    expect((await post({ rows: [{ line: 2, modelNumber: 'X', sellingPrice: -5 }] })).status).toBe(400);
    expect(await post({ rows: [{ line: 2, modelNumber: 'A-1' }, { line: 3, modelNumber: 'a-1' }] })).toEqual({ status: 400, body: { error: 'a-1 is in the rows twice.' } });
    expect(db.statements).toEqual([]);
  });
});
