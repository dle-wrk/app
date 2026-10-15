import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ query: async () => ({ rows: [] }), queryOne: async () => null, exec: async () => {}, pool: {} }));

import { auditDetails, auditWrites, describeWrite, redact, shouldAudit } from './auditLog';
import { shouldLogShownError, setShownErrorScreen } from './shownErrorLog';

describe('what is logged', () => {
  it('every change, but not reads, sign-in, the log itself or heartbeats', () => {
    expect(shouldAudit('POST', '/api/invoices')).toBe(true);
    expect(shouldAudit('DELETE', '/api/items/CAP-001')).toBe(true);
    expect(shouldAudit('GET', '/api/invoices')).toBe(false);
    for (const p of ['/api/login', '/api/session/verify', '/api/auth/change-password', '/api/activity-log', '/api/kits/4/presence', '/api/pricing/oauth/start']) expect(shouldAudit('POST', p), p).toBe(false);
  });

  it('names the action in the log style, with the record', () => {
    expect(describeWrite('POST', '/api/invoices')).toEqual({ action: 'CREATE_INVOICES', entityType: 'invoices', entityId: null });
    expect(describeWrite('PUT', '/api/items/CAP-001')).toEqual({ action: 'UPDATE_ITEMS', entityType: 'items', entityId: 'CAP-001' });
    expect(describeWrite('POST', '/api/invoices/7/void')).toEqual({ action: 'INVOICES_VOID', entityType: 'invoices', entityId: '7' });
    expect(describeWrite('POST', '/api/potential-orders/from-invoice/7')).toEqual({ action: 'POTENTIAL_ORDERS_FROM_INVOICE', entityType: 'potential-orders', entityId: '7' });
    expect(describeWrite('POST', '/api/items/bulk')).toEqual({ action: 'ITEMS_BULK', entityType: 'items', entityId: null });
  });
});

describe('what is kept', () => {
  it('hides secrets, records files by size, cuts long text and big lists', () => {
    const file = 'A'.repeat(40_000);
    expect(redact({ name: 'Kit A', password: 'hunter2', apiKey: 'k', nested: { refresh_token: 't' }, documentData: file, note: 'x'.repeat(400), lines: Array.from({ length: 25 }, (_, i) => i) })).toEqual({
      name: 'Kit A', password: '[hidden]', apiKey: '[hidden]', nested: { refresh_token: '[hidden]' }, documentData: '[file, 29 KB]',
      note: `${'x'.repeat(300)}… (400 characters)`, lines: [...Array.from({ length: 20 }, (_, i) => i), '(+5 more)'],
    });
  });

  it('keeps the details under the size limit', () => {
    const big = { rows: Array.from({ length: 20 }, () => ({ a: 'y'.repeat(299), b: 'z'.repeat(299), c: 'q'.repeat(299) })) };
    const d = JSON.parse(auditDetails({ method: 'POST', path: '/api/items/bulk', status: 200, ms: 5, body: big, query: {}, error: null }));
    expect(d.sent).toBe('[too large to keep]');
    expect(d).toMatchObject({ source: 'auto', httpStatus: 200 });
  });
});

describe('the recorder', () => {
  const run = async (method: string, path: string, status: number, reply: any, user?: any, body: any = {}) => {
    const inserts: any[][] = [];
    const listeners: Record<string, Function> = {};
    const req: any = { method, baseUrl: '/api', path: path.replace(/^\/api/, ''), body, query: {}, headers: { 'user-agent': 'test' }, user };
    const res: any = { statusCode: status, json(b: any) { return b; }, on(e: string, f: Function) { listeners[e] = f; } };
    const next = vi.fn();
    auditWrites(async (_sql, params) => { inserts.push(params); })(req, res, next);
    expect(next).toHaveBeenCalled();
    res.json(reply);
    listeners.finish?.();
    await new Promise((r) => setTimeout(r, 0));
    return inserts;
  };

  it('records a success, a failure with its error, and a refusal, by whoever it was', async () => {
    const [ok] = await run('POST', '/api/invoices', 201, { id: 1 }, { email: 'dylan@lumaxenergy.com' }, { clientId: 3, items: [] });
    expect([ok[0], ok[1], ok[7]]).toEqual(['dylan@lumaxenergy.com', 'CREATE_INVOICES', 'SUCCESS']);
    expect(JSON.parse(ok[4]).sent).toEqual({ clientId: 3, items: [] });

    const [bad] = await run('POST', '/api/invoices', 400, { error: 'Invalid invoice payload' }, { email: 'a@x.com' });
    expect(bad[7]).toBe('ERROR');
    expect(JSON.parse(bad[4])).toMatchObject({ httpStatus: 400, error: 'Invalid invoice payload' });

    const [refused] = await run('DELETE', '/api/sales-packages/3', 403, { error: 'Your role cannot delete bookkeeping records.' }, { email: 'eng@x.com' });
    expect(JSON.parse(refused[4]).error).toContain('cannot');
    const [anon] = await run('POST', '/api/items', 401, { error: 'Sign in required' });
    expect(anon[0]).toBeNull(); // no account: stored empty, who it was in the details
    expect(JSON.parse(anon[4]).actor).toBe('not signed in');
  });

  it('leaves reads alone', async () => {
    expect(await run('GET', '/api/invoices', 200, [])).toEqual([]);
  });
});

describe('errors shown on screen', () => {
  it('are logged once a minute at most for the same message on the same screen', () => {
    setShownErrorScreen('bookkeeping');
    expect(shouldLogShownError('Choose the client.', 1000)).toBe(true);
    expect(shouldLogShownError('Choose the client.', 30_000)).toBe(false);
    expect(shouldLogShownError('Add at least one line.', 30_000)).toBe(true);
    expect(shouldLogShownError('Choose the client.', 70_000)).toBe(true);
    setShownErrorScreen('items');
    expect(shouldLogShownError('Add at least one line.', 31_000)).toBe(true);
  });
});
