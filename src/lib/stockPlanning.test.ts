import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ pool: { connect: async () => { throw new Error('no database in tests'); } }, query: async () => ({ rows: [] }), queryOne: async () => null, exec: async () => {} }));

import { locationCode, placesOf, putHerePlan } from './stockPlaces';
import { countDifferences, nowFor, type CountLine } from './stockCounts';
import { explode, planParts, type PartInfo } from './materialPlan';

describe('stock places', () => {
  it('what has no location is the stock less what the places hold', () => {
    const bins: any[] = [{ qty: 1000 }, { qty: 500 }];
    expect(placesOf(4020, bins)).toEqual({ placed: 1500, unplaced: 2520, over: 0 });
    expect(placesOf(1200, bins)).toEqual({ placed: 1500, unplaced: 0, over: 300 }); // places hold more than stock: count it
    expect(locationCode(' reel rack 2 ')).toBe('REEL-RACK-2');
  });

  it('puts an item away in the location named after it, after counting it there (ANT-001: 200 with no location)', () => {
    expect(putHerePlan(200, 200, 'elsewhere')).toEqual({ move: 200, stockChange: 0 }); // matches
    expect(putHerePlan(200, 195, 'elsewhere')).toEqual({ move: 195, stockChange: 0 }); // 5 somewhere else: stay with no location
    expect(putHerePlan(200, 195, 'missing')).toEqual({ move: 195, stockChange: -5 }); // 5 not there: off stock
    expect(putHerePlan(200, 210, 'elsewhere')).toEqual({ move: 210, stockChange: 10 }); // 10 found: added
    expect(putHerePlan(0, 0, 'elsewhere')).toEqual({ move: 0, stockChange: 0 });
  });
});

describe('stock counts', () => {
  const line = (id: number, serial: string, bin: number | null, counted: number | null, extra: Partial<CountLine> = {}): CountLine =>
    ({ id, serial_number: serial, bin_id: bin, location_id: bin === null ? null : 1, lot: null, expected: 0, counted, ...extra });
  const state = { binQty: new Map([[10, 700], [11, 500]]), unplaced: new Map([['RES-024', 300]]) };

  it('compares each count with what the system says now, per item', () => {
    const lines = [line(1, 'RES-024', 10, 690), line(2, 'RES-024', 11, 500), line(3, 'RES-024', null, 320), line(4, 'CAP-024', null, null)];
    expect(lines.map((l) => nowFor(l, state))).toEqual([700, 500, 300, 0]);
    expect([...countDifferences(lines, state)]).toEqual([['RES-024', 10]]); // -10 on the reel, +20 loose; CAP-024 not counted: left alone
  });

  it('a place found during the count starts from nothing; one emptied since the count started counts from 0', () => {
    const found = line(5, 'LED-005', null, 40, { location_id: 3, added: true } as any);
    expect(nowFor(found, state)).toBe(0);
    expect(nowFor(line(6, 'RES-024', 99, 0), state)).toBe(0);
    expect([...countDifferences([found], state)]).toEqual([['LED-005', 40]]);
  });
});

describe('material planning', () => {
  const info = (stock: number, extra: Partial<PartInfo> = {}): PartInfo => ({ name: '', stock, safety: 0, leadDays: 21, leadNote: 'DIGIKEY, typed', supplier: 'DIGIKEY', ...extra });

  it('breaks a product into its boards, leaving DNF lines out', () => {
    // TCU-001-SAT = 1 × TCU06 PCB + 2 × POWER PACK; 15 units on the order
    const tcu06 = [{ code: 'CAP-024', qtyPerBoard: 16 }, { code: 'DNF-013', qtyPerBoard: 1 }, { code: 'RES-033', qtyPerBoard: 18 }];
    const pack = [{ code: 'RES-033', qtyPerBoard: 2 }];
    expect(explode(15, [{ perUnit: 1, lines: tcu06 }, { perUnit: 2, lines: pack }])).toEqual([{ code: 'CAP-024', qty: 240 }, { code: 'RES-033', qty: 330 }]);
  });

  it('finds when a part first runs short, what to buy, and the order-by date', () => {
    const today = new Date('2026-10-26T00:00:00Z');
    const rows = planParts(
      [{ partNumber: 'CAP-024', qty: 1500, needBy: '2026-11-20', source: 'SO-1' }, { partNumber: 'CAP-024', qty: 1000, needBy: '2026-12-10', source: 'Job 7' }, { partNumber: 'RES-033', qty: 100, needBy: '2026-11-01', source: 'SO-1' }],
      [{ partNumber: 'CAP-024', qty: 500, due: '2026-12-01', source: 'PO-2026-0007' }],
      new Map([['CAP-024', info(1800)], ['RES-033', info(4752)]]), today,
    );
    expect(rows.map((r) => [r.partNumber, r.shortfall, r.shortBy, r.orderBy, r.late])).toEqual([
      ['CAP-024', 200, '2026-12-10', '2026-11-19', false], // 1800 - 1500 = 300; +500 on 1 Dec = 800; -1000 on 10 Dec = -200
      ['RES-033', 0, null, null, false],
    ]);
  });

  it('flags an order-by date already past, and a demand with no date as needed now', () => {
    const today = new Date('2026-10-26T00:00:00Z');
    const [r] = planParts([{ partNumber: 'LED-005', qty: 500, needBy: null, source: 'Kit TCU06' }], [], new Map([['LED-005', info(0, { leadDays: 30 })]]), today);
    expect([r.shortfall, r.shortBy, r.orderBy, r.late]).toEqual([500, '2026-10-26', '2026-09-26', true]);
  });

  it('keeps a safety level when asked, and never plans a DNF part', () => {
    const rows = planParts([{ partNumber: 'CAP-019', qty: 500, needBy: '2026-11-01', source: 'SO' }, { partNumber: 'DNF-013', qty: 500, needBy: '2026-11-01', source: 'SO' }],
      [], new Map([['CAP-019', info(600, { safety: 200 })]]), new Date('2026-10-26T00:00:00Z'));
    expect(rows.map((r) => [r.partNumber, r.shortfall])).toEqual([['CAP-019', 100]]);
  });
});
