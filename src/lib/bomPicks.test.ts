import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ pool: {}, query: vi.fn(), queryOne: vi.fn(), exec: vi.fn() }));

import { isReel, lineState, pickLinesFrom, scanQty } from './bomPicks';
import { permissionForWrite } from './writeAccess';
import { lineNotes, matchLine, placeFor } from '../scan/BomPick';
import { scannedBomLines } from '../components/BomPickPanel';
import type { BomPickLine } from '../scan/api';

describe('the lines of a BOM pick', () => {
  it("each BOM line's picks (its own SKU and alternates), or its own code for all it needs", () => {
    expect(pickLinesFrom([
      { bomCode: 'RES-033', need: 18000, picks: [{ code: 'RES-033', qty: 4752 }, { code: 'RES-041', qty: 13248 }] },
      { bomCode: 'CAP-024', need: 400, picks: [] },
      { bomCode: 'LED-005', need: 0 },
      { bomCode: ' ', need: 5 },
    ])).toEqual([
      { bomCode: 'RES-033', code: 'RES-033', need: 4752 },
      { bomCode: 'RES-033', code: 'RES-041', need: 13248 },
      { bomCode: 'CAP-024', code: 'CAP-024', need: 400 },
    ]);
  });
  it('says when there is nothing to pick', () => {
    expect(() => pickLinesFrom([])).toThrow('no BOM lines');
    expect(() => pickLinesFrom([{ bomCode: 'X', need: 0 }])).toThrow('nothing to pick');
  });
});

describe('a scan against a line', () => {
  it('on a reel: the whole reel, whatever is asked, even past what the BOM needs', () => {
    expect(isReel('X1 REEL')).toBe(true);
    expect(isReel('2 reels')).toBe(true);
    expect(isReel('X1 PACKET')).toBe(false);
    expect(isReel(null)).toBe(false);
    expect(scanQty({ reel: true, available: 4000, remaining: 400, asked: 10 })).toBe(4000);
    expect(scanQty({ reel: true, available: 300, remaining: 400 })).toBe(300);
  });
  it('otherwise: what the line still needs by default, never more than it needs or the place holds', () => {
    expect(scanQty({ reel: false, available: 1000, remaining: 40 })).toBe(40);
    expect(scanQty({ reel: false, available: 25, remaining: 40 })).toBe(25);
    expect(scanQty({ reel: false, available: 1000, remaining: 40, asked: 30 })).toBe(30);
    expect(() => scanQty({ reel: false, available: 1000, remaining: 40, asked: 41 })).toThrow('needs only 40');
    expect(() => scanQty({ reel: false, available: 10, remaining: 40, asked: 20 })).toThrow('Only 10 there');
    expect(() => scanQty({ reel: false, available: 10, remaining: 40, asked: 0 })).toThrow('1 or more');
    expect(() => scanQty({ reel: false, available: 10, remaining: 0 })).toThrow('already picked');
    expect(() => scanQty({ reel: true, available: 0, remaining: 5 })).toThrow('Nothing is left');
  });
  it('a line is green once what was scanned covers it', () => {
    expect([lineState(10, 0), lineState(10, 4), lineState(10, 10), lineState(10, 4000)]).toEqual(['todo', 'part', 'done', 'done']);
  });
  it('needs the same permission as changing stock', () => {
    expect(permissionForWrite('POST', '/api/bom-picks/3/scans')).toBe('inventory.update');
    expect(permissionForWrite('POST', '/api/bom-picks/3/book-out')).toBe('inventory.update');
  });
});

const line = (over: Partial<BomPickLine>): BomPickLine => ({
  id: 1, bomCode: 'RES-033', code: 'RES-033', need: 18000, picked: 0, state: 'todo', itemsForBomLine: 1, item: { name: '10k', description: null, makerPartNumber: null, stock: 0, packaging: 'X1 REEL' },
  reel: true, places: [], scans: [], ...over,
});

describe('the phone, picking', () => {
  const lines = [
    line({ id: 1, code: 'RES-033', need: 4752, picked: 4752, state: 'done', itemsForBomLine: 2 }),
    line({ id: 2, code: 'RES-041', need: 13248, itemsForBomLine: 2, places: [{ binId: 5, locationCode: 'RES-041', locationName: null, lot: null, dateCode: null, qty: 8000, available: 8000 }, { binId: 6, locationCode: 'A1-03', locationName: null, lot: 'L2', dateCode: null, qty: 6000, available: 6000 }] }),
    line({ id: 3, bomCode: 'CAP-024', code: 'CAP-024', need: 400, reel: false, places: [{ binId: null, locationCode: null, locationName: null, lot: null, dateCode: null, qty: 100, available: 100 }] }),
  ];
  it('matches a scanned item to its line; null when it is not on the BOM', () => {
    expect(matchLine(lines, ['res-041'])?.id).toBe(2);
    expect(matchLine(lines, ['RES-033'])?.state).toBe('done');
    expect(matchLine(lines, ['LED-005'])).toBeNull();
  });
  it("takes the place a Tracklab reel label names, else the only place left", () => {
    expect(placeFor(lines[1], 'a1-03')?.binId).toBe(6);
    expect(placeFor(lines[1], null, 'L2')?.binId).toBe(6);
    expect(placeFor(lines[1])).toBeNull(); // two places: the picker chooses
    expect(placeFor(lines[2])?.binId).toBeNull();
  });
  it('says when a BOM line needs several items, more than one reel, or is short', () => {
    expect(lineNotes(lines[1], lines)).toEqual(['BOM line RES-033 needs 2 items: RES-033, RES-041', 'Needs more than one reel']);
    expect(lineNotes(lines[2], lines)).toEqual(['Short: only 100 left to pick']);
  });
  it('the desktop: a BOM line is green once every item for it is in', () => {
    const pick: any = { status: 'OPEN', lines: [{ bomCode: 'RES-033', state: 'done' }, { bomCode: 'RES-033', state: 'part' }, { bomCode: 'CAP-024', state: 'done' }] };
    expect([...scannedBomLines(pick)]).toEqual(['CAP-024']);
    expect([...scannedBomLines({ ...pick, status: 'BOOKED' })]).toEqual([]);
  });
});
