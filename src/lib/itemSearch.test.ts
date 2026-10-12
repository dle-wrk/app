import { describe, expect, it } from 'vitest';
import { footprintKey, footprintOptions, itemFootprints, itemMatches } from './itemSearch';

const item = (over: Record<string, unknown>) => ({ partNumber: 'CAP-003', name: '100NF', description: '', stockLevel: 1, price: 0, category: 'Capacitors', status: 'ACTIVE', ...over }) as any;

describe('itemMatches', () => {
  it('finds a footprint, value or part number in any field, not just the name', () => {
    const cap = item({ footprint: '1206', value: '100nF', manPns: ['CL31B104KBCNNNC'], supPns: ['', '1276-1003-1-ND'] });
    expect(itemMatches(cap, '1206')).toBe(true);
    expect(itemMatches(cap, 'cl31b104')).toBe(true);
    expect(itemMatches(cap, '1276-1003')).toBe(true);
    expect(itemMatches(cap, '0603')).toBe(false);
  });

  it('needs every word somewhere, in any order', () => {
    const cap = item({ footprint: '1206', value: '100nF', description: 'Ceramic capacitor X7R' });
    expect(itemMatches(cap, '1206 100nf')).toBe(true);
    expect(itemMatches(cap, 'x7r   1206')).toBe(true);
    expect(itemMatches(cap, '1206 10uF')).toBe(false);
    expect(itemMatches(cap, '   ')).toBe(true);
  });

  it('ignores the placeholders N/A and -', () => {
    expect(itemMatches(item({ size: 'N/A', packageName: '-' }), 'n/a')).toBe(false);
  });
});

describe('footprints', () => {
  it('treat spellings of one footprint as one', () => {
    expect(['SOT23', 'sot-23', 'SOT 23', 'C1206', '1206', 'DO-214AA (SMB)', 'SMA(DO-214AC)'].map(footprintKey))
      .toEqual(['SOT-23', 'SOT-23', 'SOT-23', '1206', '1206', 'DO-214AA', 'SMA']);
  });

  it('come from the footprint, package and size fields, and are listed with counts', () => {
    expect(itemFootprints(item({ footprint: '0603 (1608 metric)', packageName: 'N/A', size: '0603' }))).toEqual(['0603']);
    const items = [item({ footprint: '1206' }), item({ packageName: 'C1206' }), item({ size: '1206' }), item({ footprint: 'SOT-23' }), item({})];
    expect(footprintOptions(items)).toEqual([{ key: '1206', count: 3 }, { key: 'SOT-23', count: 1 }]);
  });
});
