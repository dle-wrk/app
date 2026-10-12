// Dollar to rand on screens that show a rand figure next to a dollar cost.
// The rate is the app's daily one (GET /api/exchange-rate, loaded by App);
// until it has loaded, or when there is none, the fallback is used and the
// screen says so. This replaces fixed rates that were written into the pages
// (18.50 on the inventory cards, 19 in the item form).

export const FALLBACK_USD_TO_ZAR = 18.5;

export function usdToZarRate(live: number | null | undefined): { rate: number; live: boolean } {
  return live && Number.isFinite(live) && live > 0 ? { rate: live, live: true } : { rate: FALLBACK_USD_TO_ZAR, live: false };
}

/** "at 18.23 ZAR/USD (today's rate)" or "at 18.50 ZAR/USD (fallback: the daily rate isn't loaded)". */
export function rateNote(r: { rate: number; live: boolean }): string {
  return `at ${r.rate.toFixed(2)} ZAR/USD ${r.live ? '(the daily rate)' : "(fallback: the daily rate isn't loaded)"}`;
}
