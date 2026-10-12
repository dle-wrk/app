// Reading a product from any shop's page (an item's "other" web links, 4-5,
// or any link that isn't LCSC, Mouser or DigiKey). Most shops publish the
// product as structured data for search engines (JSON-LD "Product": name,
// brand, mpn, sku), and nearly all have Open Graph tags (og:title, the
// shop's name). readProductPage reads those; value, tolerance and package
// are picked out of the product's name and description where they are
// written plainly (100nF, ±10%, 0603, SOT-23). Fetching: ./safeFetch.

import type { ProductDetails } from './productLink';

const decode = (s: string) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&nbsp;/g, ' ').replace(/&micro;/g, 'µ').replace(/&plusmn;/g, '±').replace(/&ohm;|&Omega;/g, 'Ω').replace(/&amp;/g, '&');
const clean = (v: unknown) => {
  const s = decode(String(v ?? '')).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return s || null;
};

/** A <meta> tag's content, by property or name. */
function meta(html: string, key: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attr = (n: string) => tag.match(new RegExp(`\\b${n}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
    const k = attr('property') ?? attr('name') ?? attr('itemprop');
    if (k && (k[1] ?? k[2]).toLowerCase() === key.toLowerCase()) {
      const c = attr('content');
      if (c) return clean(c[1] ?? c[2]);
    }
  }
  return null;
}

/** The JSON-LD Product on the page, if there is one. */
function ldProduct(html: string): any | null {
  const isProduct = (x: any) => x && (x['@type'] === 'Product' || (Array.isArray(x['@type']) && x['@type'].includes('Product')));
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: any;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const queue: any[] = [data];
    while (queue.length) {
      const x = queue.shift();
      if (Array.isArray(x)) { queue.push(...x); continue; }
      if (!x || typeof x !== 'object') continue;
      if (isProduct(x)) return x;
      if (x['@graph']) queue.push(x['@graph']);
      if (x.mainEntity) queue.push(x.mainEntity);
    }
  }
  return null;
}

const nameOf = (v: any): string | null => clean(typeof v === 'string' ? v : Array.isArray(v) ? nameOf(v[0]) : v?.name);

const VALUE = /(?<![\w.])(\d+(?:[.,]\d+)?\s?(?:pF|nF|[uµμ]F|mF|[mkKM]?Ω|[kKM]?ohms?|[nuµμm]H))(?![a-z])/i;
const TOLERANCE = /±\s?\d+(?:\.\d+)?\s?%/;
const PACKAGE = /\b(01005|0201|0402|0603|0805|1206|1210|1812|2010|2512|SOT-?23(?:-\d)?|SOT-?223|SOT-?89|SOD-?\d{2,3}|SOIC-?\d+|SOP-?\d+|TSSOP-?\d+|MSOP-?\d+|QFN-?\d+|LQFP-?\d+|DIP-?\d+|TO-?220|TO-?92|TO-?252|DO-?214A[ABC]|SMA|SMB|SMC)\b/i;

/** The main word of a site's address: "communica" for www.communica.co.za. */
function hostWord(url: string): string {
  try {
    const parts = new URL(url).hostname.toLowerCase().replace(/^www\./, '').split('.');
    const i = parts.length > 2 && parts[parts.length - 2].length <= 3 ? parts.length - 3 : parts.length - 2;
    return parts[Math.max(0, i)] || '';
  } catch { return ''; }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The site's name: what it calls itself, else its address without "www.". */
function siteName(html: string, url: string, title: string | null): string {
  const own = meta(html, 'og:site_name')?.replace(/[.\s]+$/, '');
  const word = hostWord(url);
  // A lower-case name like "aliexpress": take how the page writes it ("AliExpress").
  if (word && (!own || own.toLowerCase() === word)) {
    const written = `${title ?? ''} ${meta(html, 'og:title') ?? ''}`.match(new RegExp(`\\b${escapeRe(word)}\\b`, 'i'))?.[0];
    if (written && written !== written.toLowerCase()) return written;
  }
  if (own) return own;
  try { return new URL(url).hostname.replace(/^www\./i, ''); } catch { return 'the site'; }
}

/** A product name without the shop's name, slogan or "[Part No: …]" around it. */
function stripSite(t: string | null, url: string, site: string): string | null {
  if (!t) return null;
  const word = hostWord(url);
  let out = t.split(/\s+[|–—]\s+/)[0];
  for (const n of [site, word].filter((x) => x && x.length > 2)) {
    out = out.replace(new RegExp(`\\s+-\\s+${escapeRe(n)}\\b.*$`, 'i'), '');
  }
  out = out.replace(/\s*\[(?:part|item|sku)\s*(?:no|number|#)?\.?:?[^\]]*\]\s*$/i, '').trim();
  return out || t;
}

/** Signed download links (they stop working within the hour) aren't kept as the datasheet. */
const expires = (href: string) => /[?&](x-oss-|x-amz-|expires=|signature=|token=)/i.test(href);

/** A datasheet link on the page: a PDF called a datasheet, or failing that the only PDF. */
function datasheetLink(html: string, url: string): string | null {
  const pdfs: Array<{ href: string; text: string }> = [];
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+\.pdf(?:[?#][^"']*)?)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try { pdfs.push({ href: new URL(decode(m[1]), url).toString(), text: m[2] }); } catch { /* not a link */ }
  }
  return pdfs.find((p) => !expires(p.href) && /data\s?-?sheet|\bspec(?:ification)?s?\b/i.test(`${p.href} ${p.text}`))?.href ?? null;
}

/** The product on a shop's page, or null when the page doesn't say what it is. */
export function readProductPage(html: string, url: string): ProductDetails | null {
  const ld = ldProduct(html);
  const title = clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
  const site = siteName(html, url, title);
  const name = stripSite(clean(ld?.name), url, site) ?? stripSite(meta(html, 'og:title'), url, site) ?? stripSite(title, url, site);
  if (!name) return null;
  const about = clean(ld?.description) ?? meta(html, 'og:description') ?? meta(html, 'description') ?? '';
  const text = `${name} ${about}`;
  const sku = clean(ld?.sku);
  const mpn = clean(ld?.mpn);
  const valueRaw = text.match(VALUE)?.[1] ?? null;
  // A "brand" that is the shop itself isn't the manufacturer.
  const brand = nameOf(ld?.brand) ?? nameOf(ld?.manufacturer);
  const word = hostWord(url);
  const manufacturer = brand && ![site.toLowerCase(), word].some((n) => n && brand.toLowerCase().startsWith(n)) ? brand : null;
  return {
    supplier: 'other',
    supplierName: site,
    supplierPartNumber: sku && sku !== mpn ? sku : null,
    manufacturerPartNumber: mpn ?? (sku && /\d/.test(sku) && /[a-z]/i.test(sku) ? sku : null),
    manufacturer,
    description: name.slice(0, 250),
    value: valueRaw ? valueRaw.replace(/\s+/g, '').replace(/[uμ]F$/i, 'µF').replace(/ohms?$/i, 'Ω') : null,
    tolerance: text.match(TOLERANCE)?.[0].replace(/\s+/g, '') ?? null,
    package: text.match(PACKAGE)?.[1].toUpperCase() ?? null,
    datasheet: datasheetLink(html, url),
    extra: [],
  };
}

/** Whether a page is a "prove you're a person" wall rather than the product. */
export function isBotWall(status: number, html: string): boolean {
  if (status === 403 || status === 429 || status === 503) return true;
  return /<title[^>]*>\s*(just a moment|attention required|access denied|security check)/i.test(html)
    || /\b(cf-chl-|_cf_chl_opt|captcha-delivery|px-captcha|punish-component)/i.test(html.slice(0, 20000));
}
