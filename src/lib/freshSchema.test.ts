// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// ensureSchema on an empty database: every table must be created after the
// tables it refers to. A stand-in for Postgres refuses a REFERENCES to a
// table that doesn't exist yet, the way the real one does ("relation
// client_orders does not exist" stopped a fresh server from ever finishing
// its setup).

const pgState = vi.hoisted(() => ({ tables: new Set<string>(), created: [] as string[] }));

vi.mock('pg', () => {
  class Pool {
    async query(text: string) {
      const sql = text.replace(/\s+/g, ' ').trim();
      if (/information_schema\.tables/.test(sql)) return { rows: [{ exists: false }], rowCount: 1 };
      const create = sql.match(/^CREATE TABLE IF NOT EXISTS "?(\w+)"?/i);
      if (create) {
        for (const ref of sql.matchAll(/REFERENCES (\w+)\s*\(/gi)) {
          if (ref[1] !== create[1] && !pgState.tables.has(ref[1])) {
            throw Object.assign(new Error(`relation "${ref[1]}" does not exist (creating ${create[1]})`), { code: '42P01' });
          }
        }
        pgState.tables.add(create[1]);
        pgState.created.push(create[1]);
      }
      return { rows: [], rowCount: 0 };
    }
    async connect() { return { query: this.query.bind(this), release: () => {} }; }
    async end() {}
  }
  return { default: { Pool }, Pool };
});

let dir = '';
const cwd = process.cwd;
beforeAll(() => {
  process.env.DATABASE_URL ||= 'postgres://test@localhost/test';
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-schema-'));
  process.cwd = () => dir; // no assets/: the fallback sample data is used
});
afterAll(() => { process.cwd = cwd; fs.rmSync(dir, { recursive: true, force: true }); });

describe('ensureSchema on an empty database', () => {
  it('creates every table after the tables it refers to', async () => {
    const { ensureSchema } = await import('./db');
    await expect(ensureSchema()).resolves.toBeUndefined();
    expect(pgState.created.indexOf('client_orders')).toBeLessThan(pgState.created.indexOf('production_jobs'));
    expect(pgState.created).toEqual(expect.arrayContaining(['inventory', 'projects', 'clients', 'client_orders', 'production_jobs', 'order_fulfillment']));
  });
});
