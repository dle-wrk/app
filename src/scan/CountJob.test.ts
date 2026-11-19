import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/db', () => ({ pool: {}, query: vi.fn(), queryOne: vi.fn(), exec: vi.fn() }));

import { countEntries, placesFrom } from './CountJob';
import { stillDue } from './api';
import { parseQuickCount } from '../lib/stockCounts';

const bins = [
  { id: 5, location_id: 4, location_code: 'REEL-RACK-2', lot: 'L1', date_code: '2431', qty: 4000 },
  { id: 6, location_id: null, location_code: null, lot: 'L2', qty: 1000 },
];

describe('counting an item on the phone', () => {
  it("lists the item's places, then what isn't put away", () => {
    expect(placesFrom({ bins, unplaced: 300 }).map(p => [p.key, p.code, p.lot, p.qty])).toEqual([['b5', 'REEL-RACK-2', 'L1', 4000], ['b6', null, 'L2', 1000], ['none', null, null, 300]]);
    expect(placesFrom({ bins, unplaced: 0 }).map(p => p.key)).toEqual(['b5', 'b6']);
    // Nothing anywhere: one "No location" place, so there is something to count into.
    expect(placesFrom({ bins: [], unplaced: 0 })).toEqual([{ key: 'none', binId: null, locationId: null, code: null, lot: null, dateCode: null, qty: 0 }]);
  });

  it('sends only the places that changed, and places found elsewhere', () => {
    const places = placesFrom({ bins, unplaced: 300 });
    expect(countEntries(places, { b5: '4000', b6: '', none: '300' }, [])).toEqual([]);
    expect(countEntries(places, { b5: '3800', b6: '1000', none: '0' }, [{ key: 'a1', locationId: 9, counted: '50' }, { key: 'a2', locationId: null, counted: '' }])).toEqual([
      { binId: 5, locationId: null, lot: null, counted: 3800 },
      { binId: null, locationId: null, lot: null, counted: 0 },
      { binId: null, locationId: 9, lot: null, counted: 50 },
    ]);
  });

  it('the server checks what the phone sends', () => {
    expect(parseQuickCount({ serialNumber: ' CAP-1 ', counts: [{ binId: 5, counted: 3 }, { locationId: '9', lot: ' L3 ', counted: '0' }] }))
      .toEqual({ serial: 'CAP-1', entries: [{ binId: 5, locationId: null, lot: null, counted: 3 }, { binId: null, locationId: 9, lot: 'L3', counted: 0 }] });
    expect(() => parseQuickCount({ counts: [{ counted: 1 }] })).toThrow('Scan the item');
    expect(() => parseQuickCount({ serialNumber: 'A', counts: [] })).toThrow('how many');
    expect(() => parseQuickCount({ serialNumber: 'A', counts: [{ counted: -1 }] })).toThrow('whole number');
    expect(() => parseQuickCount({ serialNumber: 'A', counts: [{ counted: 1.5 }] })).toThrow('whole number');
    expect(() => parseQuickCount({ serialNumber: 'A', counts: [{ binId: 5, counted: 1 }, { binId: 5, counted: 2 }] })).toThrow('twice');
    expect(() => parseQuickCount({ serialNumber: 'A', counts: [{ binId: 'x', counted: 1 }] })).toThrow('not valid');
  });

  it("what's still due on a PO or kit line: never below 0", () => {
    expect(stillDue(100, 40, 20)).toBe(40);
    expect(stillDue(100, 90, 20)).toBe(0);
  });
});
