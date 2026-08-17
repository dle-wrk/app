import { describe, it, expect } from 'vitest';
import { sanitizeSupplierLinks } from './safeUrls';

describe('sanitizeSupplierLinks', () => {
  it('keeps http(s) URLs untouched', () => {
    const urls = sanitizeSupplierLinks(['https://digikey.com/x', 'http://mouser.co.za/y']);
    expect(urls.map((u) => u.href)).toEqual([
      'https://digikey.com/x',
      'http://mouser.co.za/y',
    ]);
  });

  it('drops javascript:, mailto:, and other non-http schemes', () => {
    // These are the ones that were rendering as broken sourcing buttons or
    // — worse — a live XSS surface before the URL sanitiser existed.
    const urls = sanitizeSupplierLinks([
      'javascript:alert(1)',
      'mailto:foo@bar.com',
      'ftp://example.com',
      'data:text/html,<script>alert(1)</script>',
    ]);
    expect(urls).toHaveLength(0);
  });

  it('drops relative paths', () => {
    const urls = sanitizeSupplierLinks(['/relative/path', './x', '../up']);
    expect(urls).toHaveLength(0);
  });

  it('drops empty and whitespace-only entries', () => {
    const urls = sanitizeSupplierLinks(['', ' ', '\t\n']);
    expect(urls).toHaveLength(0);
  });

  it('drops nulls and non-strings without throwing', () => {
    const urls = sanitizeSupplierLinks([null, undefined, 42, {} as any]);
    expect(urls).toHaveLength(0);
  });

  it('trims surrounding whitespace before parsing', () => {
    const urls = sanitizeSupplierLinks(['  https://digikey.com/x  ']);
    expect(urls).toHaveLength(1);
    expect(urls[0].hostname).toBe('digikey.com');
  });
});
