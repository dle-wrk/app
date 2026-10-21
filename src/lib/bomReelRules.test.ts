import { describe, expect, it } from 'vitest';
import { allocateAllByTier, otherLinesParts, withPickedElsewhere } from './kitTierFill';
import { mergeBomLines } from './mergeBomLines';

const c = (serialNumber: string, stock: number, matchTier = 2) => ({ serialNumber, stock, matchTier });

describe('a reel already listed is not suggested again', () => {
  it("never uses another line's own part, and counts what earlier lines took from a reel", () => {
    // CAP-024 and CAP-022 are both lines; CAP-025 is a shared alternate with 2 000.
    const matches = {
      'CAP-024': [c('CAP-024', 1800, 1), c('CAP-022', 5000), c('CAP-025', 2000)],
      'CAP-030': [c('CAP-030', 0, 1), c('CAP-025', 2000)],
      'CAP-022': [c('CAP-022', 5000, 1)],
    };
    const r = allocateAllByTier([{ code: 'CAP-024', needed: 3000 }, { code: 'CAP-030', needed: 1500 }, { code: 'CAP-022', needed: 1000 }], matches, {});
    expect(r.allocations['CAP-024']).toEqual([{ allocatedCode: 'CAP-024', qty: 1800 }, { allocatedCode: 'CAP-025', qty: 1200 }]); // not CAP-022: it's a line
    expect(r.allocations['CAP-030']).toEqual([{ allocatedCode: 'CAP-025', qty: 800 }]); // only what CAP-024 left of CAP-025
    expect(r.allocations['CAP-022']).toEqual([{ allocatedCode: 'CAP-022', qty: 1000 }]);
    expect([r.filled, r.short]).toEqual([3, 1]);
  });

  it('gives the reel picker the other lines and what they have picked', () => {
    expect([...otherLinesParts(['CAP-024', 'cap-022', 'LED-005'], 'CAP-024')]).toEqual(['CAP-022', 'LED-005']);
    expect(withPickedElsewhere({ 'CAP-025': 100 }, { 'CAP-024': [{ allocatedCode: 'CAP-025', qty: 1200 }], 'CAP-030': [{ allocatedCode: 'CAP-025', qty: 800 }] }, 'CAP-030'))
      .toEqual({ 'CAP-025': 1300 }); // its own picks aren't counted against it
  });
});

describe('a part listed twice in a BOM is one line', () => {
  it('adds the quantities and joins the designators (TCU06 CAP-024: 5 + 11)', () => {
    const line = (id: string, stockCode: string, quantity: number, designator: string) => ({ id, stockCode, quantity, designator, description: '', comment: '', footprint: '1206' });
    const merged = mergeBomLines([line('a', 'CAP-024', 5, 'C47, C43, C44, C49, C50'), line('b', 'RES-033', 18, 'R1'), line('c', 'CAP-024', 11, 'C14, C15')]);
    expect(merged.map((l) => [l.stockCode, l.quantity, l.designator, l.mergedFrom])).toEqual([
      ['CAP-024', 16, 'C47, C43, C44, C49, C50, C14, C15', 2], ['RES-033', 18, 'R1', 1],
    ]);
  });
});
