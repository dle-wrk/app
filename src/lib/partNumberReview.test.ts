// @vitest-environment node
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The part-number review: the rules (reviewItems), and the real routes on a
// real Express app against an in-memory inventory that understands the
// statements they send.

vi.mock('./db', () => ({
  pool: { connect: async () => { throw new Error('the real pool must not be used in tests'); } },
  query: async () => { throw new Error('the real query must not be used in tests'); },
  queryOne: async () => null,
  exec: async () => {},
}));

import { registerPartNumberReviewRoutes, reviewItems, type ReviewDeps } from './partNumberReview';
import { preferredSupplier } from './partNumbers';
import { mapDbRowToItem, mapItemToPayload } from './mapDbItem';

const FIELDS = ['man_pn_1', 'man_pn_2', 'man_pn_3', 'man_pn_4', 'man_pn_5', 'sup_pn_1', 'sup_pn_2', 'sup_pn_3', 'sup_pn_4', 'sup_pn_5'];
const item = (serial_number: string, values: Record<string, string | null>, extra: Record<string, unknown> = {}) =>
  ({ serial_number, name: `${serial_number} name`, supplier: null, ...Object.fromEntries(FIELDS.map((f) => [f, null])), ...values, ...extra });

describe('reviewItems', () => {
  it('moves the first supplier name to Supplier, and clears the copies', () => {
    const issues = reviewItems([item('BUT-002', { man_pn_1: 'N/A', sup_pn_1: 'MOUSER ELECTRONICS', sup_pn_2: 'DIGIKEY', sup_pn_3: 'LCSC' })]);

    expect(issues.filter((i) => i.kind === 'supplier_name').map((i) => [i.field, i.value, i.fix])).toEqual([
      ['sup_pn_1', 'MOUSER ELECTRONICS', { action: 'move_to_supplier' }],
      ['sup_pn_2', 'DIGIKEY', { action: 'clear' }],
      ['sup_pn_3', 'LCSC', { action: 'clear' }],
    ]);
    expect(issues.find((i) => i.field === 'sup_pn_2')!.note).toContain('the item\'s supplier is MOUSER ELECTRONICS');
  });

  it('only clears a supplier name when the item already has that supplier', () => {
    const [issue] = reviewItems([item('CAP-019', { man_pn_1: 'GRM188R61E474KA12D', sup_pn_1: 'Digikey' }, { supplier: 'DIGIKEY' })]);

    expect(issue).toMatchObject({ kind: 'supplier_name', fix: { action: 'clear' } });
    expect(issue.note).toBe("Already the item's supplier (DIGIKEY). Clearing removes the copy.");
  });

  it('fixes an LCSC number with extra text, clears placeholders, and leaves the app\'s own N/A and Generic alone', () => {
    const issues = reviewItems([
      item('DIO-015', { man_pn_1: 'SMCJ28CA', man_pn_3: 'C2943749 BD' }),
      item('CRY-003', { man_pn_1: 'NOT ASSIGNED', man_pn_2: 'Generic', sup_pn_1: 'N/A', sup_pn_2: '300-8862-2-ND' }),
    ]);

    expect(issues.map((i) => [i.serialNumber, i.kind, i.field, i.fix])).toEqual([
      ['DIO-015', 'lcsc_extra_text', 'man_pn_3', { action: 'set', value: 'C2943749' }],
      ['CRY-003', 'placeholder', 'man_pn_1', { action: 'clear' }],
    ]);
  });

  it('flags what needs a person without offering a fix', () => {
    const issues = reviewItems([
      item('ENC-003', { man_pn_1: 'MP-C' }),
      item('Wireless Module A8', { man_pn_1: 'Wireless Module A8' }, { name: 'CHP-049', last_status: 'flagged', flagged_part_number: 'Wireless Module A8', flagged_usd: '677.4200', flagged_provider: 'mouser', flagged_match: 'XR-A826-0404C-01' }),
      item('ASS-001', { man_pn_1: 'N/A' }),
    ]);

    expect(issues.map((i) => [i.serialNumber, i.kind, i.fix])).toEqual([
      ['ENC-003', 'not_a_part_number', null],
      ['ENC-003', 'no_part_number', null],
      ['Wireless Module A8', 'held_back', null],
      ['Wireless Module A8', 'swapped', null],
      ['ASS-001', 'no_part_number', null],
    ]);
    expect(issues[2].note).toContain('677.4200 USD each from mouser (it matched XR-A826-0404C-01)');
  });

  it('does not report a hold that was on a value no longer looked up', () => {
    const issues = reviewItems([item('CRY-003', { man_pn_1: 'NOT ASSIGNED', sup_pn_2: '300-8862-2-ND' }, { last_status: 'flagged', flagged_part_number: 'NOT ASSIGNED' })]);

    expect(issues.map((i) => i.kind)).toEqual(['placeholder']);
  });
});

describe('the preferred supplier shown on an item', () => {
  it('is the Supplier field, else a supplier name in a part-number field, never a part number', () => {
    expect(preferredSupplier('Mouser', ['Digikey'])).toBe('Mouser');
    expect(preferredSupplier(null, ['595-SN65HVD232DR', 'MICRO ROBOTICS'])).toBe('MICRO ROBOTICS');
    expect(preferredSupplier('N/A', ['595-SN65HVD232DR'])).toBeNull();
    expect(preferredSupplier('', ['NOT ASSIGNED'])).toBeNull();

    expect(mapDbRowToItem({ serial_number: 'CHP-020', sup_pn_1: '595-SN65HVD232DR' }).supplier).toBe('N/A');
    expect(mapDbRowToItem({ serial_number: 'ANT-002', sup_pn_1: 'MICRO ROBOTICS' }).supplier).toBe('MICRO ROBOTICS');
    expect(mapDbRowToItem({ serial_number: 'ANT-002', supplier: 'Micro Robotics', sup_pn_1: '' }).supplier).toBe('Micro Robotics');
  });

  it('is saved to the Supplier field, never into a supplier part-number field', () => {
    const created = mapItemToPayload({ partNumber: 'CAP-100', name: '1uF', supplier: 'Digi-Key Corp', manufacturer: 'Generic', stockLevel: 0, price: 0, category: 'Capacitors', status: 'ACTIVE' } as any);
    expect(created).toMatchObject({ supplier: 'Digi-Key Corp', sup_pn_1: '', man_pn_1: 'Generic' });

    // An item saved without a supplier keeps its supplier part number, and gets no supplier.
    const loaded = mapDbRowToItem({ serial_number: 'CHP-020', sup_pn_1: '595-SN65HVD232DR', man_pn_1: 'SN65HVD232DR' });
    expect(mapItemToPayload(loaded)).toMatchObject({ supplier: '', sup_pn_1: '595-SN65HVD232DR', man_pn_1: 'SN65HVD232DR' });
  });
});

// --- the routes ---------------------------------------------------------------

let inventory: Map<string, Record<string, any>>;
let activity: Array<{ user: string; serial: string; details: any }>;
let failOnUpdate: boolean;
let statements: string[];

function fakeClient() {
  let snapshot: typeof inventory | null = null;
  const copy = () => new Map([...inventory].map(([k, v]) => [k, { ...v }]));
  const query = async (text: string, p: any[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    statements.push(sql);
    if (sql === 'BEGIN') { snapshot = copy(); return { rows: [], rowCount: 0 }; }
    if (sql === 'COMMIT') { snapshot = null; return { rows: [], rowCount: 0 }; }
    if (sql === 'ROLLBACK') { if (snapshot) inventory = snapshot; snapshot = null; return { rows: [], rowCount: 0 }; }
    if (sql.startsWith('SELECT i.serial_number, i.name, i.supplier,') && sql.includes('FROM inventory i LEFT JOIN bulk_price_status')) {
      return { rows: [...inventory.values()].filter((r) => !r.deleted).sort((a, b) => a.serial_number.localeCompare(b.serial_number)), rowCount: 0 };
    }
    if (sql.startsWith('SELECT i.serial_number, i.name, i.supplier,') && sql.endsWith('FOR UPDATE')) {
      return { rows: [...inventory.values()].filter((r) => p[0].includes(r.serial_number) && !r.deleted), rowCount: 0 };
    }
    let m = sql.match(/^UPDATE inventory SET supplier = CASE WHEN COALESCE\(TRIM\(supplier\), ''\) IN \('', 'N\/A'\) THEN \$2 ELSE supplier END, "(\w+)" = NULL WHERE serial_number = \$1 RETURNING supplier$/);
    if (m) {
      if (failOnUpdate) throw new Error('connection reset');
      const r = inventory.get(p[0])!;
      if (!String(r.supplier ?? '').trim() || String(r.supplier).trim() === 'N/A') r.supplier = p[1];
      r[m[1]] = null;
      return { rows: [{ supplier: r.supplier }], rowCount: 1 };
    }
    m = sql.match(/^UPDATE inventory SET "(\w+)" = NULL WHERE serial_number = \$1$/);
    if (m) { if (failOnUpdate) throw new Error('connection reset'); inventory.get(p[0])![m[1]] = null; return { rows: [], rowCount: 1 }; }
    m = sql.match(/^UPDATE inventory SET "(\w+)" = \$2 WHERE serial_number = \$1$/);
    if (m) { inventory.get(p[0])![m[1]] = p[1]; return { rows: [], rowCount: 1 }; }
    if (sql.startsWith("INSERT INTO user_activity_logs (user_email, action, entity_type, entity_id, details, status) VALUES ($1, 'FIX_PART_NUMBER', 'Item', $2, $3, 'SUCCESS')")) {
      activity.push({ user: p[0], serial: p[1], details: JSON.parse(p[2]) });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected SQL in test: ${sql}`);
  };
  return { query, release: () => {} };
}

const deps: ReviewDeps = {
  query: (t, p) => fakeClient().query(t, p),
  connect: async () => fakeClient() as any,
};

let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', (req: any, _res, next) => {
    const role = req.headers['x-test-role'];
    if (role) req.user = { id: 1, email: `${role}@example.com`, role: String(role) };
    next();
  });
  registerPartNumberReviewRoutes(app, deps);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));

beforeEach(() => {
  inventory = new Map([
    ['ANT-002', item('ANT-002', { man_pn_1: 'YNX-433-COIL', sup_pn_1: 'MICRO ROBOTICS' })],
    ['BUT-002', item('BUT-002', { man_pn_1: 'N/A', sup_pn_1: 'MOUSER ELECTRONICS', sup_pn_2: 'DIGIKEY' })],
    ['DIO-015', item('DIO-015', { man_pn_1: 'SMCJ28CA', man_pn_3: 'C2943749 BD' })],
    ['CHP-020', item('CHP-020', { man_pn_1: 'SN65HVD232DR', sup_pn_1: '595-SN65HVD232DR' })],
  ]);
  activity = [];
  failOnUpdate = false;
  statements = [];
});

const call = async (method: string, path: string, body?: unknown, role = 'engineer') => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(role ? { 'x-test-role': role } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const fix = (serialNumber: string, field: string, action: string, expected: string, value?: string) => ({ serialNumber, field, action, expected, ...(value ? { value } : {}) });

describe('GET /api/inventory/part-number-review', () => {
  it('lists the issues with counts, and says whether the caller may fix them', async () => {
    const res = await call('GET', '/api/inventory/part-number-review', undefined, 'viewer');

    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ supplier_name: 3, lcsc_extra_text: 1, no_part_number: 1 });
    expect(res.body.fixable).toBe(4);
    expect(res.body.canFix).toBe(false);
    expect((await call('GET', '/api/inventory/part-number-review', undefined, 'manager')).body.canFix).toBe(true);
  });
});

describe('POST /api/inventory/part-number-review/fix', () => {
  it('refuses roles that may not change inventory', async () => {
    const res = await call('POST', '/api/inventory/part-number-review/fix', { fixes: [fix('ANT-002', 'sup_pn_1', 'move_to_supplier', 'MICRO ROBOTICS')] }, 'viewer');

    expect(res).toEqual({ status: 403, body: { error: 'Only admins, managers and engineers can change inventory, prices and part numbers.' } });
    expect(inventory.get('ANT-002')!.sup_pn_1).toBe('MICRO ROBOTICS');
  });

  it('moves a supplier name to Supplier, clears its copy, fixes an LCSC number, and logs each change', async () => {
    const res = await call('POST', '/api/inventory/part-number-review/fix', { fixes: [
      fix('BUT-002', 'sup_pn_2', 'clear', 'DIGIKEY'),
      fix('BUT-002', 'sup_pn_1', 'move_to_supplier', 'MOUSER ELECTRONICS'),
      fix('DIO-015', 'man_pn_3', 'set', 'C2943749 BD', 'C2943749'),
    ] });

    expect(res.status).toBe(200);
    expect(res.body.skipped).toEqual([]);
    expect(inventory.get('BUT-002')).toMatchObject({ supplier: 'MOUSER ELECTRONICS', sup_pn_1: null, sup_pn_2: null, man_pn_1: 'N/A' });
    expect(inventory.get('DIO-015')).toMatchObject({ man_pn_3: 'C2943749', man_pn_1: 'SMCJ28CA' });
    expect(activity).toEqual([
      { user: 'engineer@example.com', serial: 'BUT-002', details: { field: 'sup_pn_1', action: 'move_to_supplier', from: 'MOUSER ELECTRONICS', to: null, supplier: 'MOUSER ELECTRONICS' } },
      { user: 'engineer@example.com', serial: 'BUT-002', details: { field: 'sup_pn_2', action: 'clear', from: 'DIGIKEY', to: null } },
      { user: 'engineer@example.com', serial: 'DIO-015', details: { field: 'man_pn_3', action: 'set', from: 'C2943749 BD', to: 'C2943749' } },
    ]);
  });

  it('applies nothing the review does not offer: a real part number cannot be cleared or rewritten', async () => {
    const res = await call('POST', '/api/inventory/part-number-review/fix', { fixes: [
      fix('CHP-020', 'sup_pn_1', 'clear', '595-SN65HVD232DR'),
      fix('CHP-020', 'man_pn_1', 'set', 'SN65HVD232DR', 'C1'),
      fix('DIO-015', 'man_pn_3', 'set', 'C2943749 BD', 'C999'),
      fix('ANT-002', 'sup_pn_1', 'clear', 'MICRO ROBOTICS'),
    ] });

    expect(res.body.applied).toEqual([]);
    expect(res.body.skipped).toHaveLength(4);
    expect(inventory.get('CHP-020')).toMatchObject({ sup_pn_1: '595-SN65HVD232DR', man_pn_1: 'SN65HVD232DR' });
    expect(inventory.get('DIO-015')!.man_pn_3).toBe('C2943749 BD');
    expect(inventory.get('ANT-002')!.sup_pn_1).toBe('MICRO ROBOTICS');
    expect(activity).toEqual([]);
  });

  it('skips a fix whose value changed since the list was loaded, and applies each fix once', async () => {
    inventory.get('ANT-002')!.sup_pn_1 = 'Micro Robotics (Pty) Ltd';

    const res = await call('POST', '/api/inventory/part-number-review/fix', { fixes: [
      fix('ANT-002', 'sup_pn_1', 'move_to_supplier', 'MICRO ROBOTICS'),
      fix('DIO-015', 'man_pn_3', 'set', 'C2943749 BD', 'C2943749'),
      fix('DIO-015', 'man_pn_3', 'set', 'C2943749 BD', 'C2943749'),
    ] });

    expect(res.body.applied.map((a: any) => a.serialNumber)).toEqual(['DIO-015']);
    expect(res.body.skipped.map((s: any) => [s.serialNumber, s.reason])).toEqual([
      ['ANT-002', 'Changed since the list was loaded, or no longer needs this fix.'],
      ['DIO-015', 'Changed since the list was loaded, or no longer needs this fix.'],
    ]);
  });

  it('changes nothing when a write fails part-way', async () => {
    failOnUpdate = true;

    const res = await call('POST', '/api/inventory/part-number-review/fix', { fixes: [
      fix('DIO-015', 'man_pn_3', 'set', 'C2943749 BD', 'C2943749'),
      fix('ANT-002', 'sup_pn_1', 'move_to_supplier', 'MICRO ROBOTICS'),
    ] });

    expect(res).toEqual({ status: 500, body: { error: 'connection reset' } });
    expect(inventory.get('DIO-015')!.man_pn_3).toBe('C2943749 BD');
    expect(inventory.get('ANT-002')).toMatchObject({ sup_pn_1: 'MICRO ROBOTICS', supplier: null });
    expect(statements).toContain('ROLLBACK');
  });

  it('refuses a malformed request', async () => {
    expect((await call('POST', '/api/inventory/part-number-review/fix', { fixes: [] })).body).toEqual({ error: 'fixes must be a non-empty list.' });
    expect((await call('POST', '/api/inventory/part-number-review/fix', { fixes: [fix('A', 'name', 'clear', 'x')] })).body).toEqual({ error: 'Unknown field: name.' });
    expect((await call('POST', '/api/inventory/part-number-review/fix', { fixes: [fix('A', 'sup_pn_1', 'drop', 'x')] })).body).toEqual({ error: 'Unknown action: drop.' });
    expect((await call('POST', '/api/inventory/part-number-review/fix', { fixes: [{ serialNumber: 'A', field: 'sup_pn_1', action: 'clear' }] })).status).toBe(400);
  });
});
