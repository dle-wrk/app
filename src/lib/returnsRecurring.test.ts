import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ pool: { connect: async () => { throw new Error('no database in tests'); } }, query: async () => ({ rows: [] }), queryOne: async () => null, exec: async () => {} }));

import { advance, dueDates } from './recurringInvoices';
import { CREDITED, OUTCOMES, RESTOCKED } from './returnsRoutes';

describe('recurring invoice dates', () => {
  it('moves on by the period, keeping the day of the month where it can', () => {
    expect(advance('2026-01-31', 'MONTHLY')).toBe('2026-02-28');
    expect(advance('2028-01-31', 'MONTHLY')).toBe('2028-02-29'); // leap year
    expect(advance('2026-02-28', 'MONTHLY')).toBe('2026-03-28');
    expect(advance('2026-11-15', 'QUARTERLY')).toBe('2027-02-15');
    expect(advance('2026-10-26', 'YEARLY')).toBe('2027-10-26');
    expect(advance('2026-10-26', 'WEEKLY', 2)).toBe('2026-11-09');
    expect(advance('2026-10-26', 'MONTHLY', 6)).toBe('2027-04-26');
  });

  it('catches up dates missed while the server was down, stops at the end date, at most 12', () => {
    expect(dueDates('2026-08-01', 'MONTHLY', 1, '2026-10-26', null)).toEqual({ dates: ['2026-08-01', '2026-09-01', '2026-10-01'], next: '2026-11-01' });
    expect(dueDates('2026-11-01', 'MONTHLY', 1, '2026-10-26', null)).toEqual({ dates: [], next: '2026-11-01' }); // not due yet
    expect(dueDates('2026-08-01', 'MONTHLY', 1, '2026-10-26', '2026-09-15')).toEqual({ dates: ['2026-08-01', '2026-09-01'], next: '2026-10-01' });
    expect(dueDates('2025-01-05', 'WEEKLY', 1, '2026-10-26', null).dates).toHaveLength(12);
  });
});

describe('return outcomes', () => {
  it('restocks only what goes back on the shelf, and credits restocked, scrapped and credit-only lines', () => {
    expect(OUTCOMES).toEqual(['RESTOCK', 'SCRAP', 'REPAIR', 'REPLACE', 'CREDIT']);
    expect(RESTOCKED).toEqual(['RESTOCK']);
    expect(CREDITED).toEqual(['RESTOCK', 'SCRAP', 'CREDIT']); // a repair or a replacement isn't credited
  });
});
