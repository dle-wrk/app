import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ pool: { connect: async () => { throw new Error('no database in tests'); } }, query: async () => ({ rows: [] }), queryOne: async () => null, exec: async () => {} }));

import { advance, dueDates } from './recurringInvoices';
import { CREDITED, OUTCOMES, RESTOCKED, repairDescription, repairPlan } from './returnsRoutes';

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

describe('repairs', () => {
  const lines = [
    { id: 1, part_number: 'INV-5K', description: 'Inverter 5kW', serial_numbers: 'SN123', quantity: '1', repair_status: 'IN_REPAIR' },
    { id: 2, part_number: 'BAT-1', description: 'Battery', serial_numbers: null, quantity: '2', repair_status: 'IN_REPAIR' },
    { id: 3, part_number: 'CBL', description: 'Cable', serial_numbers: null, quantity: '1', repair_status: 'REPAIRED' },
    { id: 4, part_number: 'X', description: 'Restocked', serial_numbers: null, quantity: '1', repair_status: null },
  ];

  it('names the item and its serials on the invoice and the delivery note', () => {
    expect(repairDescription(lines[0])).toBe('Repair: Inverter 5kW (S/N SN123)');
    expect(repairDescription({ part_number: 'P1' })).toBe('Repair: P1');
  });

  it('takes the charge each (empty is no charge, for warranty) and the note', () => {
    const plan = repairPlan(lines, [{ lineId: 1, charge: '850.555', note: ' Replaced the fan ' }, { lineId: '2', charge: '' }]);
    expect(plan.map((p) => [p.line.id, p.charge, p.note])).toEqual([[1, 850.56, 'Replaced the fan'], [2, 0, null]]);
  });

  it('only sends back lines still in repair, once each, at a charge of 0 or more', () => {
    expect(() => repairPlan(lines, [])).toThrow('Choose what has been repaired');
    expect(() => repairPlan(lines, [{ lineId: 3 }])).toThrow("isn't waiting for repair");
    expect(() => repairPlan(lines, [{ lineId: 4 }])).toThrow("isn't waiting for repair");
    expect(() => repairPlan(lines, [{ lineId: 9 }])).toThrow('Line not found');
    expect(() => repairPlan(lines, [{ lineId: 1 }, { lineId: 1 }])).toThrow('picked twice');
    expect(() => repairPlan(lines, [{ lineId: 1, charge: -5 }])).toThrow("can't be negative");
    expect(() => repairPlan(lines, [{ lineId: 1, charge: 'abc' }])).toThrow("can't be negative");
  });
});
