import { describe, expect, it, vi } from 'vitest';
import { actionOf, recipientOf, isDue, diffHits, notice, isTrigger } from './automationEngine';
vi.mock('./db', () => ({ query: async () => ({ rows: [] }), queryOne: async () => null, exec: async () => {}, pool: {} }));

describe('automation rules', () => {
  it('reads actions saved before rules ran', () => {
    expect(actionOf({ type: 'CREATE_PO', autoApprove: false })).toEqual({ type: 'DRAFT_PO' });
    expect(actionOf({ type: 'ENRICH_SUPPLIERS', endpoint: '/x' })).toEqual({ type: 'NOTIFY', to: 'everyone' });
    expect(actionOf('{"type":"NOTIFY","to":"role:admin"}')).toEqual({ type: 'NOTIFY', to: 'role:admin' });
    expect(actionOf('not json')).toEqual({ type: 'NOTIFY', to: 'everyone' });
  });

  it('tells everyone, a role, or one email address', () => {
    expect(recipientOf('ROLE:Manager')).toBe('role:manager');
    expect(recipientOf(' Dylan@Example.com ')).toBe('dylan@example.com');
    expect(recipientOf('role:owner')).toBe('everyone');
    expect(recipientOf(undefined)).toBe('everyone');
  });

  it('is due when its period has passed, a little early allowed; never when run by hand only', () => {
    const now = new Date('2026-10-27T10:15:00Z');
    expect(isDue('day', null, now)).toBe(true);
    expect(isDue('day', '2026-10-26T10:15:30Z', now)).toBe(true); // the hourly check lands a few seconds late
    expect(isDue('day', '2026-10-26T11:15:00Z', now)).toBe(false);
    expect(isDue('hour', '2026-10-27T09:15:20Z', now)).toBe(true);
    expect(isDue('week', '2026-10-21T10:15:00Z', now)).toBe(false);
    expect(isDue(null, null, now)).toBe(false);
    expect(isDue('fortnight', null, now)).toBe(false);
  });

  it('tells people only about what is new; a hit that clears is new when it returns', () => {
    const hits = (...ids: string[]) => ids.map((id) => ({ id, label: id, detail: '' }));
    expect(diffHits([], hits('A', 'B'))).toEqual({ fresh: hits('A', 'B'), cleared: [] });
    expect(diffHits(['A', 'B'], hits('B', 'C'))).toEqual({ fresh: hits('C'), cleared: ['A'] });
    expect(diffHits(['B', 'C'], hits('A', 'B', 'C')).fresh).toEqual(hits('A'));
  });

  it('words the notification, listing the first 15', () => {
    const fresh = Array.from({ length: 17 }, (_, i) => ({ id: `C${i}`, label: `CAP-0${i}`, detail: `${i} left` }));
    const n = notice('Low stock', 'LOW_STOCK', fresh, 40);
    expect(n.subject).toBe('Low stock: 17 items are low on stock (40 in all)');
    expect(n.message).toMatch(/^CAP-00 \(0 left\); CAP-01 \(1 left\);/);
    expect(n.message).toMatch(/; and 2 more\.$/);
    expect(notice('Late', 'PO_LATE', fresh.slice(0, 1), 1).subject).toBe('Late: 1 purchase order is late');
  });

  it('knows what it can watch', () => {
    expect(isTrigger('INVOICE_OVERDUE')).toBe(true);
    expect(isTrigger('SCHEDULED')).toBe(false);
    expect(isTrigger('toString')).toBe(false);
  });
});
