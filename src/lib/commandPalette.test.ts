import { describe, it, expect } from 'vitest';
import { fuzzyScore, scoreRoute, ROUTES } from './commandPalette';

// The palette's fuzzy match is the difference between a useful Ctrl+K and one
// that returns nothing. These tests pin the behaviour the UI depends on:
// exact-prefix wins, word boundaries beat contains-anywhere, and known
// synonyms in the keyword field surface the right destination.

describe('fuzzyScore', () => {
  it('gives a positive score for an exact substring match', () => {
    expect(fuzzyScore('dash', 'Dashboard').score).toBeGreaterThan(0);
  });

  it('scores a prefix match higher than a mid-string match', () => {
    const prefix = fuzzyScore('dash', 'Dashboard').score;
    const mid = fuzzyScore('board', 'Dashboard').score;
    expect(prefix).toBeGreaterThan(mid);
  });

  it('returns -1 for a query that is not a subsequence of the target', () => {
    expect(fuzzyScore('xyz', 'Dashboard').score).toBe(-1);
  });

  it('scores word-boundary matches higher than lone-letter matches', () => {
    const wordBoundary = fuzzyScore('co', 'Component Alternates').score;
    const arbitrary = fuzzyScore('co', 'Reports & Ledger co').score; // 'co' appears mid-word only
    expect(wordBoundary).toBeGreaterThan(arbitrary);
  });

  it('returns matched-index list for a substring hit', () => {
    const { matches } = fuzzyScore('dash', 'Dashboard');
    expect(matches).toEqual([0, 1, 2, 3]);
  });
});

describe('scoreRoute', () => {
  const getRoute = (id: string) => {
    const r = ROUTES.find((r) => r.id === id);
    if (!r) throw new Error(`Test route not found: ${id}`);
    return r;
  };

  it('surfaces the Delivery & Collection route for "collection note"', () => {
    // This is the specific query the user complained about in the mobile
    // survey — regression here would silently break their most-used flow.
    const dispatch = scoreRoute(getRoute('bk_dispatch'), 'collection note');
    const invoices = scoreRoute(getRoute('bk_invoices'), 'collection note');
    expect(dispatch).toBeGreaterThan(invoices);
    expect(dispatch).toBeGreaterThan(0);
  });

  it('scores keyword hits (not just labels)', () => {
    // "digikey" is only in the keywords field of the Pricing route.
    const pricing = scoreRoute(getRoute('pricing'), 'digikey');
    expect(pricing).toBeGreaterThan(0);
  });

  it('weights label matches above keyword matches', () => {
    // "invoice" hits the label of bk_invoices AND the keywords of bk_bills.
    const invoiceLabel = scoreRoute(getRoute('bk_invoices'), 'invoice');
    const invoiceKeyword = scoreRoute(getRoute('bk_bills'), 'invoice');
    expect(invoiceLabel).toBeGreaterThan(invoiceKeyword);
  });

  it('returns -1 for a query that matches nothing in the route', () => {
    expect(scoreRoute(getRoute('dashboard'), 'zzznope')).toBe(-1);
  });
});
