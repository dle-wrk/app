// Central money-formatting helper. South African standard (SANS 24 /
// ISO 31): space thousands separator, dot decimal, no space between
// currency symbol and first digit.
//
//   fmtCurrency(1234.5)                → "R1 234.50"
//   fmtCurrency(1234567.89)            → "R1 234 567.89"
//   fmtCurrency(-89, 'USD')            → "-$89.00"
//   fmtCurrency(0)                     → "R0.00"
//   fmtCurrency(null)                  → "R0.00"
//
// Grouping is done by hand rather than through toLocaleString so the
// output is deterministic across browsers and locales — different
// Chrome / Firefox builds resolve `undefined` locale differently and
// some ZA accounts still get comma-thousands from the browser.
//
// The thousands separator is a non-breaking space ( ) so the
// number never wraps mid-value in a narrow cell.

const CURRENCY_SYMBOLS: Record<string, string> = {
  ZAR: 'R', USD: '$', EUR: '€', GBP: '£',
};

// Group the integer part into non-breaking-space triples.
export function groupInt(intStr: string): string {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

// Format a numeric amount using SANS 24 grouping.
// - `currency` picks the prefix symbol (R by default). Unknown codes
//   fall through to R so a stray value never renders as "undefined123".
// - `dp` is the fraction-digit count (default 2). Pass 0 for whole-
//   unit displays like stock counts if you want the grouping without
//   the decimals.
export function fmtCurrency(amount: number | string | null | undefined, currency: string = 'ZAR', dp: number = 2): string {
  const n = Number(amount);
  const safe = Number.isFinite(n) ? n : 0;
  const symbol = CURRENCY_SYMBOLS[currency] || 'R';
  const abs = Math.abs(safe).toFixed(dp);
  const parts = abs.split('.');
  const grouped = groupInt(parts[0]);
  return `${safe < 0 ? '-' : ''}${symbol}${grouped}${parts[1] ? '.' + parts[1] : ''}`;
}

// Shortcut for R-prefix (South African rand) — the most common case
// across the app.
export function fmtZAR(amount: number | string | null | undefined, dp: number = 2): string {
  return fmtCurrency(amount, 'ZAR', dp);
}

// Shortcut for $-prefix (US dollar).
export function fmtUSD(amount: number | string | null | undefined, dp: number = 2): string {
  return fmtCurrency(amount, 'USD', dp);
}

// Format a bare number with SANS 24 grouping and no currency symbol.
// Used for stock counts and other integer-ish displays where the
// grouping still improves readability.
export function fmtNumber(n: number | string | null | undefined, dp: number = 0): string {
  const num = Number(n);
  const safe = Number.isFinite(num) ? num : 0;
  const abs = Math.abs(safe).toFixed(dp);
  const parts = abs.split('.');
  const grouped = groupInt(parts[0]);
  return `${safe < 0 ? '-' : ''}${grouped}${parts[1] ? '.' + parts[1] : ''}`;
}
