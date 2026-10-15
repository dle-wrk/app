import { describe, expect, it } from 'vitest';
import { expandPackage, inCurrency, markupPrice, packageTotals, wouldContainItself, type SalesPackage } from './salesPackages';

const pkg = (id: number, name: string, lines: SalesPackage['lines'], discountPct = 0): SalesPackage =>
  ({ id, name, category: null, tags: [], clientId: null, discountPct, notes: null, active: true, lines });

const battery = pkg(2, 'Battery add-on', [
  { kind: 'item', ref: 'BAT-5K', description: '5kWh Battery', quantity: 1, unitPrice: 22000, taxRateId: 1 },
]);
const kitA = pkg(1, 'Solar Kit A', [
  { kind: 'product', ref: 'INV-5K', description: '5kW Inverter', quantity: 1, unitPrice: 18500, taxRateId: 1 },
  { kind: 'package', ref: '2', description: '', quantity: 2, unitPrice: 0, taxRateId: null },
  { kind: 'service', ref: null, description: 'Installation', quantity: 1, unitPrice: 6500, taxRateId: 1 },
], 5);
const byId = new Map([[1, kitA], [2, battery]]);

describe('expandPackage', () => {
  it('puts every line on the order, a package inside at its quantity, the discount as its own line', () => {
    expect(expandPackage(1, byId)).toEqual([
      { kind: 'product', partNumber: 'INV-5K', description: '5kW Inverter', quantity: 1, unitPrice: 18500, taxRateId: 1 },
      { kind: 'item', partNumber: 'BAT-5K', description: '5kWh Battery', quantity: 2, unitPrice: 22000, taxRateId: 1 },
      { kind: 'service', partNumber: null, description: 'Installation', quantity: 1, unitPrice: 6500, taxRateId: 1 },
      { kind: 'discount', partNumber: null, description: 'Solar Kit A discount (5%)', quantity: 1, unitPrice: -3450, taxRateId: 1 },
    ]);
  });

  it('gives one discount line per tax rate', () => {
    const mixed = pkg(3, 'Spares', [
      { kind: 'item', ref: 'A', description: 'A', quantity: 2, unitPrice: 100, taxRateId: 1 },
      { kind: 'service', ref: null, description: 'Training', quantity: 1, unitPrice: 300, taxRateId: 4 },
    ], 10);
    const d = expandPackage(3, new Map([[3, mixed]])).filter((l) => l.kind === 'discount');
    expect(d.map((l) => [l.taxRateId, l.unitPrice])).toEqual([[1, -20], [4, -30]]);
    expect(d[0].description).toBe('Spares discount (10%) on items at this tax rate');
  });

  it('refuses a package that contains itself or a missing one', () => {
    const loop = new Map([[1, pkg(1, 'A', [{ kind: 'package', ref: '2', description: '', quantity: 1, unitPrice: 0, taxRateId: null }])],
      [2, pkg(2, 'B', [{ kind: 'package', ref: '1', description: '', quantity: 1, unitPrice: 0, taxRateId: null }])]]);
    expect(() => expandPackage(1, loop)).toThrow('"A" contains itself.');
    expect(() => expandPackage(9, byId)).toThrow('Package #9 no longer exists.');
  });
});

describe('wouldContainItself', () => {
  it('spots a loop through other packages before it is saved', () => {
    const line = (ref: string) => ({ kind: 'package' as const, ref, description: '', quantity: 1, unitPrice: 0, taxRateId: null });
    expect(wouldContainItself(2, [line('1')], byId)).toBe(true);  // Battery add-on containing Kit A, which contains it
    expect(wouldContainItself(1, [line('2')], byId)).toBe(false);
    expect(wouldContainItself(null, [line('1')], byId)).toBe(false); // a new package can't be inside anything yet
  });
});

describe('totals', () => {
  it('total after discount, and margin from costs (services cost nothing; unknown costs are flagged)', () => {
    const lines = expandPackage(1, byId);
    const costs: Record<string, number> = { 'INV-5K': 12000, 'BAT-5K': 15000 };
    expect(packageTotals(lines, (l) => costs[l.partNumber!] ?? null)).toEqual({
      gross: 69000, discount: -3450, total: 65550, cost: 42000, costKnown: true, marginPct: 35.9,
    });
    expect(packageTotals(lines, () => null).costKnown).toBe(false);
  });

  it('converts rand prices to the order currency, and prices at cost + markup', () => {
    expect(inCurrency([{ kind: 'item', partNumber: 'X', description: 'X', quantity: 1, unitPrice: 185, taxRateId: 1 }], 18.5)[0].unitPrice).toBe(10);
    expect(markupPrice(100, 35)).toBe(135);
  });
});
