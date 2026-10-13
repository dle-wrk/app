import { describe, expect, it } from 'vitest';
import { isBotWall, readProductPage } from './pageProduct';
import { isPrivateAddress, publicUrl } from './safeFetch';
import { applyFill, canLookUp, fillOptions } from './productLink';
import { blankSlotsToNA } from './partNumbers';

const ld = (o: object) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;

describe('readProductPage', () => {
  it('reads a JSON-LD product, without the shop name around it, and a datasheet link', () => {
    const html = `<html><head><title>4N35 - Communica [Part No: 4N35]</title>
      <meta property="og:site_name" content="Communica South Africa">
      ${ld({ '@context': 'https://schema.org', '@type': 'Product', name: '4N35 - Communica [Part No: 4N35]', sku: 'COM-4N35', mpn: '4N35', brand: { '@type': 'Brand', name: 'Communica' } })}
      </head><body><a href="/files/specials.pdf">Specials</a><a href="/docs/4n35-datasheet.pdf">Download</a></body></html>`;
    expect(readProductPage(html, 'https://www.communica.co.za/products/4n35')).toEqual({
      supplier: 'other', supplierName: 'Communica South Africa', supplierPartNumber: 'COM-4N35', manufacturerPartNumber: '4N35',
      manufacturer: null, // the shop, not the maker
      description: '4N35', value: null, tolerance: null, package: null,
      datasheet: 'https://www.communica.co.za/docs/4n35-datasheet.pdf', extra: [],
    });
  });

  it('finds the product in an @graph, and the brand', () => {
    const html = ld({ '@graph': [{ '@type': 'WebSite' }, { '@type': ['Product'], name: 'Scoop Fibre Flylead Lc-Lc Mm 5M | Shop Online In SA', sku: 'FF-LCLC-M5U', brand: 'Scoop' }] });
    const d = readProductPage(html, 'https://romtech.co.za/product/x/')!;
    expect([d.description, d.manufacturer, d.manufacturerPartNumber, d.supplierName]).toEqual(['Scoop Fibre Flylead Lc-Lc Mm 5M', 'Scoop', 'FF-LCLC-M5U', 'romtech.co.za']);
  });

  it('falls back to Open Graph, takes the shop name as the page writes it, and picks out value, tolerance and package', () => {
    const html = `<meta property="og:site_name" content="aliexpress."><meta property="og:title" content="100PCS 0603 SMD Capacitor 100nF &plusmn;10% 50V X7R - AliExpress 7">`;
    const d = readProductPage(html, 'https://www.aliexpress.com/item/1.html')!;
    expect([d.supplierName, d.description, d.value, d.tolerance, d.package, d.manufacturerPartNumber]).toEqual(['AliExpress', '100PCS 0603 SMD Capacitor 100nF ±10% 50V X7R', '100nF', '±10%', '0603', null]);
  });

  it('skips a signed datasheet link that expires, and a page that says nothing', () => {
    const html = `<title>HJ-2.4GHz-SMA | HJ Tech | JLCPCB</title><a href="https://x.aliyuncs.com/a.pdf?x-oss-expires=1800">Datasheet</a>`;
    expect(readProductPage(html, 'https://jlcpcb.com/partdetail/x/C1')!.datasheet).toBeNull();
    expect(readProductPage('<html><body>hi</body></html>', 'https://a.com/')).toBeNull();
  });
});

describe('isBotWall', () => {
  it('tells a "just a moment" page from a product', () => {
    expect(isBotWall(403, '')).toBe(true);
    expect(isBotWall(200, '<title>Just a moment...</title>')).toBe(true);
    expect(isBotWall(200, '<title>4N35</title><form>captcha for the newsletter</form>')).toBe(false);
  });
});

describe('the page fetch only reaches the public internet', () => {
  it('refuses private, loopback and metadata addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fdaa::3', 'fe80::1', '::ffff:127.0.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    expect(isPrivateAddress('104.18.10.1')).toBe(false);
    expect(isPrivateAddress('2606:4700::1')).toBe(false);
  });

  it('refuses links that are not ordinary public web pages', () => {
    for (const u of ['file:///etc/passwd', 'ftp://a.com/x', 'http://localhost/', 'http://app.internal/', 'http://127.0.0.1/', 'http://[::1]/', 'http://a.com:3001/', 'http://user:pw@a.com/', 'http://intranet/']) {
      expect(() => publicUrl(u), u).toThrow();
    }
    expect(publicUrl('https://www.acdcexpress.com/product/MP-C').hostname).toBe('www.acdcexpress.com');
  });
});

describe('filling from another shop', () => {
  const d = { supplier: 'other' as const, supplierName: 'ACDC Express', supplierPartNumber: 'ACDC-1', manufacturerPartNumber: 'MP-C', manufacturer: null,
    description: 'D.M.C ENCLOSURE', value: null, tolerance: null, package: null, datasheet: null, extra: [] };

  it('puts the part numbers in the slot its link is in (4 or 5)', () => {
    const options = fillOptions({}, d, 4).filter((o) => o.field === 'manPn' || o.field === 'supPn');
    expect(options.map((o) => o.label)).toEqual(['Manufacturer PN (Mfr PN 5, ACDC Express)', 'ACDC Express PN (Sup PN 5)']);
    expect(applyFill({}, d, options)).toEqual({ manPns: ['', '', '', '', 'MP-C'], supPns: ['', '', '', '', 'ACDC-1'] });
    expect(fillOptions({}, d, 1).find((o) => o.field === 'manPn')!.slot).toBe(3); // a link in a supplier's slot: 4
  });

  it('looks up any web link, not only supplier pages', () => {
    expect(['https://www.aliexpress.com/item/1.html', 'https://www.lcsc.com/product-detail/C1.html', 'aliexpress', 'N/A', 'mailto:a@b.com'].map(canLookUp)).toEqual([true, true, false, false, false]);
  });
});

describe('saving an item', () => {
  it('writes N/A into a part-number or link slot saved empty, and leaves the rest alone', () => {
    expect(blankSlotsToNA({ man_pn_2: '', sup_pn_1: '  ', weblink_5: '', sup_pn_3: 'C1', name: '', supplier: '' }))
      .toEqual({ man_pn_2: 'N/A', sup_pn_1: 'N/A', weblink_5: 'N/A', sup_pn_3: 'C1', name: '', supplier: '' });
    expect(blankSlotsToNA({ name: 'x' })).toEqual({ name: 'x' }); // slots not sent aren't touched
  });
});
