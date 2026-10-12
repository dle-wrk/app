import { describe, expect, it } from 'vitest';
import { inPriceRange, isPriceRangeSet } from './priceFilter';

const usd = (min: string, max: string) => ({ currency: 'USD' as const, min, max });
const zar = (min: string, max: string) => ({ currency: 'ZAR' as const, min, max });

describe('inPriceRange', () => {
  it('keeps everything when no bound is set (or a bound is unreadable)', () => {
    expect(inPriceRange(5, usd('', ''), 18.5)).toBe(true);
    expect(inPriceRange(5, usd('abc', ''), 18.5)).toBe(true);
    expect(isPriceRangeSet(usd(' ', 'x'))).toBe(false);
  });

  it('compares dollars, ends included', () => {
    expect([0.5, 1, 3.2, 10, 10.01].map((p) => inPriceRange(p, usd('1', '10'), 18.5))).toEqual([false, true, true, true, false]);
    expect(inPriceRange(250, usd('100', ''), 18.5)).toBe(true);
    expect(inPriceRange(99, usd('100', ''), 18.5)).toBe(false);
    expect(inPriceRange(0.02, usd('', '0,05'), 18.5)).toBe(true);
  });

  it('compares rand at the rate the cards show', () => {
    // $10 shows as R185.00
    expect(inPriceRange(10, zar('185', '185'), 18.5)).toBe(true);
    expect(inPriceRange(10, zar('', 'R 184,99'), 18.5)).toBe(false);
    expect(inPriceRange(100, zar('1 000', ''), 18.5)).toBe(true);
  });

  it('treats an item without a price as 0', () => {
    expect(inPriceRange(undefined, usd('', '1'), 18.5)).toBe(true);
    expect(inPriceRange(null, usd('0,01', ''), 18.5)).toBe(false);
  });
});
