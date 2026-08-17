// Shared URL sanitiser used by the Kit Booking sourcing column and any other
// place that renders stored supplier weblinks. The stored strings are dirty
// (users paste anything into weblink_1..5), so anything that fails the
// WHATWG URL parser or isn't http/https gets thrown away.

export function sanitizeSupplierLinks(input: unknown[]): URL[] {
  return input
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((v) => v.length > 0)
    .map((v) => {
      try {
        return new URL(v);
      } catch {
        return null;
      }
    })
    .filter((u): u is URL => !!u && (u.protocol === 'http:' || u.protocol === 'https:'));
}
