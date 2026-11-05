import { describe, expect, it, vi } from 'vitest';
vi.mock('./db', () => ({ query: async () => ({ rows: [] }), queryOne: async () => null, exec: async () => {}, pool: {} }));
import { formatCode, counterOf, nextCodes, hasCounter, packetCodeFor, usage, DEFAULT_UNIT_FORMAT, DEFAULT_BATCH_FORMAT } from './projectBuilds';

describe('build serials and batches', () => {
  it('fills the product code, the year and the running number', () => {
    expect(formatCode('{MODEL}-POP-{0000}', 'TCU06', 7)).toBe('TCU06-POP-0007');
    expect(formatCode('TCU06-PCB-{0000}', 'TCU06', 12)).toBe('TCU06-PCB-0012');
    expect(formatCode('{MODEL}-{YYYY}-{000}', 'NCU05', 3, 2026)).toBe('NCU05-2026-003');
    expect(formatCode(DEFAULT_UNIT_FORMAT, 'DON-002', 1)).toBe('DON-002-0001');
    expect(formatCode(DEFAULT_BATCH_FORMAT, 'DON-002', 4)).toBe('DON-002-B004');
    expect(formatCode('{MODEL}-{00}', 'X', 1234)).toBe('X-1234'); // grows past its width
  });

  it('numbers on from the highest used, ignoring codes of other formats', () => {
    expect(counterOf('{MODEL}-POP-{0000}', 'TCU06', 'TCU06-POP-0041')).toBe(41);
    expect(counterOf('{MODEL}-POP-{0000}', 'TCU06', 'tcu06-pop-0041')).toBe(41);
    expect(counterOf('{MODEL}-POP-{0000}', 'TCU06', 'TCU06-PCB-0041')).toBeNull();
    expect(nextCodes('{MODEL}-POP-{0000}', 'TCU06', ['TCU06-POP-0002', 'TCU06-POP-0009', 'TCU06-PCB-0050'], 2)).toEqual(['TCU06-POP-0010', 'TCU06-POP-0011']);
    expect(nextCodes('{MODEL}-B{000}', 'A.B', [], 1)).toEqual(['A.B-B001']); // a dot in the code is literal
  });

  it('a format needs a running number', () => {
    expect(hasCounter('{MODEL}-{0000}')).toBe(true);
    expect(hasCounter('TCU06-POP')).toBe(false);
  });
});

describe('leftovers', () => {
  it('a packet is its own code: the part and -PKT unless one is given', () => {
    expect(packetCodeFor('CAP-024')).toBe('CAP-024-PKT');
    expect(packetCodeFor('CAP-024', ' cap 024 loose ')).toBe('CAP-024-LOOSE');
  });

  it('used is sent less counted back; more back than sent is shown, never negative use', () => {
    expect(usage(
      [{ serial_number: 'A', booked_out: 10 }, { serial_number: 'B', booked_out: 5 }, { serial_number: 'C', booked_out: 3 }],
      [{ serial_number: 'A', counted: 4 }, { serial_number: 'A', counted: 1 }, { serial_number: 'B', counted: 8 }],
    )).toEqual([
      { serial_number: 'A', bookedOut: 10, returned: 5, used: 5, over: 0 },
      { serial_number: 'B', bookedOut: 5, returned: 8, used: 0, over: 3 },
      { serial_number: 'C', bookedOut: 3, returned: 0, used: 3, over: 0 },
    ]);
  });
});
