import { describe, expect, it } from 'vitest';
import { groupByMonth } from './groupByMonth';

describe('grouping rows by month', () => {
  it('puts the newest month first, keeps order inside a month, and undated rows last', () => {
    const rows = [
      { n: 1, d: '2026-08-12' },
      { n: 2, d: '2026-11-11T00:00:00.000Z' },
      { n: 3, d: null },
      { n: 4, d: '2026-11-10' },
      { n: 5, d: '2025-12-01' },
    ];
    const groups = groupByMonth(rows, r => r.d);
    expect(groups.map(g => g.label)).toEqual(['November 2026', 'August 2026', 'December 2025', 'No date']);
    expect(groups[0].items.map(r => r.n)).toEqual([2, 4]);
    expect(groups[0].key).toBe('2026-11');
  });

  it('returns nothing for no rows', () => {
    expect(groupByMonth([], () => '2026-01-01')).toEqual([]);
  });
});
