// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// On a live database, start-up replaces the item status rule
// (inventory_status_check) when it doesn't allow every status yet, in one
// statement, and leaves it alone when it does.

const pgState = vi.hoisted(() => ({ rule: '' as string | null, sent: [] as string[] }));

vi.mock('pg', () => {
  class Pool {
    async query(text: string) {
      const sql = text.replace(/\s+/g, ' ').trim();
      pgState.sent.push(sql);
      if (/information_schema\.tables/.test(sql)) return { rows: [{ exists: true }], rowCount: 1 };
      if (/FROM pg_constraint/.test(sql)) return { rows: pgState.rule === null ? [] : [{ def: pgState.rule }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
    async connect() { return { query: this.query.bind(this), release: () => {} }; }
    async end() {}
  }
  return { default: { Pool }, Pool };
});

process.env.DATABASE_URL ||= 'postgres://test@localhost/test';
const { ensureSchema } = await import('./db');
const alters = () => pgState.sent.filter((s) => s.startsWith('ALTER TABLE inventory DROP CONSTRAINT'));

beforeEach(() => { pgState.sent = []; });

describe('the item status rule', () => {
  it('is replaced when it lacks DO NOT USE', async () => {
    pgState.rule = "CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'INACTIVE'::text, 'BOOKED OUT'::text, 'DISCONTINUED'::text])))";
    await ensureSchema();
    expect(alters()).toEqual([
      "ALTER TABLE inventory DROP CONSTRAINT IF EXISTS inventory_status_check, ADD CONSTRAINT inventory_status_check CHECK (status IN ('ACTIVE', 'INACTIVE', 'BOOKED OUT', 'DISCONTINUED', 'DO NOT USE'))",
    ]);
  });

  it('is left alone when it allows every status', async () => {
    pgState.rule = "CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'INACTIVE'::text, 'BOOKED OUT'::text, 'DISCONTINUED'::text, 'DO NOT USE'::text])))";
    await ensureSchema();
    expect(alters()).toEqual([]);
  });

  it('is added when there is none', async () => {
    pgState.rule = null;
    await ensureSchema();
    expect(alters()).toHaveLength(1);
  });
});
