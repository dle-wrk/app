import { describe, expect, it } from 'vitest';
import { linesFor, nextCount } from './CountJob';
import { stillDue, type CountLine } from './api';

const line = (id: number, serial: string, lot: string | null, counted: number | null = null): CountLine =>
  ({ id, serial_number: serial, name: null, location_id: 4, location_code: 'A1', lot, date_code: null, counted, added: false });

describe('counting on the phone', () => {
  it('adds a reel to what was counted, or sets the count', () => {
    expect(nextCount(null, 4000, 'add')).toBe(4000);
    expect(nextCount(4000, 2500, 'add')).toBe(6500);
    expect(nextCount(4000, 2500, 'set')).toBe(2500);
    expect(nextCount(4000, 0, 'set')).toBe(0);
  });

  it("finds a scanned item's lines, the scanned lot first, in any case", () => {
    const lines = [line(1, 'CAP-024', 'L1'), line(2, 'RES-1K', null), line(3, 'CAP-024', 'L2'), line(4, 'CAP-024', null)];
    expect(linesFor(lines, 'cap-024').map(l => l.id)).toEqual([1, 3, 4]);
    expect(linesFor(lines, 'CAP-024', 'l2').map(l => l.id)).toEqual([3, 1, 4]);
    expect(linesFor(lines, 'LED-1')).toEqual([]);
  });

  it("what's still due on a line: never below 0", () => {
    expect(stillDue(100, 40, 20)).toBe(40);
    expect(stillDue(100, 90, 20)).toBe(0);
  });
});
