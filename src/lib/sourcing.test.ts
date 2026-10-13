import { describe, expect, it } from 'vitest';
import { itemSuppliers, matchesSourcing, sourcingCounts } from './sourcing';

const all3 = { supPns: ['187-CL10B104', '1276-1000-1-ND', 'C1591', 'N/A', 'N/A'] };
const lcscOnly = { supPns: ['N/A', 'N/A', 'C626667', 'N/A', 'N/A'] };
const misplaced = { supPns: ['C25804', '', '', '', ''] }; // an LCSC number in Mouser's slot
const nothing = { supPns: ['N/A', 'Digikey', '', '', ''] };
const noFields = {};

describe('sourcing', () => {
  it("tells which suppliers an item has a number for, by slot or a number plainly theirs", () => {
    expect(itemSuppliers(all3)).toEqual(['mouser', 'digikey', 'lcsc']);
    expect(itemSuppliers(lcscOnly)).toEqual(['lcsc']);
    expect(itemSuppliers(misplaced)).toEqual(['lcsc']);
    expect(itemSuppliers(nothing)).toEqual([]);
    expect(itemSuppliers(noFields)).toEqual([]);
  });

  it('filters and counts', () => {
    expect(matchesSourcing(lcscOnly, 'MISSING_MOUSER')).toBe(true);
    expect(matchesSourcing(lcscOnly, 'MISSING_LCSC')).toBe(false);
    expect(matchesSourcing(all3, 'SOME_MISSING')).toBe(false);
    expect(sourcingCounts([all3, lcscOnly, misplaced, nothing, noFields])).toEqual({
      ALL: 5, ALL_THREE: 1, SOME_MISSING: 4, MISSING_MOUSER: 4, MISSING_DIGIKEY: 4, MISSING_LCSC: 2, NONE: 2,
    });
  });
});
