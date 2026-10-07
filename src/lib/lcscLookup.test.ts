// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

// LCSC lookups by LCSC part number, their cache, how quotePart decides what
// LCSC is asked by, and which part-number field an item is priced by.

vi.mock('./db', () => ({
  pool: { connect: async () => { throw new Error('the real pool must not be used in tests'); } },
  query: async () => { throw new Error('the real query must not be used in tests'); },
  queryOne: async () => null,
  exec: async () => {},
}));

import { lcscPriceAt, lookupLcsc, parseLcscProduct, quotePart, type LcscDeps, type LcscProduct, type QuoteDeps } from './pricingRoutes';
import { pickPartNumbers } from './partNumbers';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-07T08:00:00Z').getTime();

// LCSC's product-detail answer for C1591, trimmed to the fields that matter.
const C1591 = {
  code: 200, msg: null, ok: true,
  result: {
    productCode: 'C1591', productModel: 'CL10B104KB8NNNC', brandNameEn: 'Samsung Electro-Mechanics', stockNumber: 1175100,
    currencyType: 'USD', currencySymbol: '$',
    productPriceList: [
      { ladder: 1000, productPrice: '0.0064', usdPrice: 0.0064, currencyPrice: 0.0064, currencySymbol: '$' },
      { ladder: 100, productPrice: '0.0085', usdPrice: 0.0085, currencyPrice: 0.0085, currencySymbol: '$' },
      { ladder: 4000, productPrice: '0.0055', usdPrice: 0.0055, currencyPrice: 0.0055, currencySymbol: '$' },
      { ladder: 100000, productPrice: '0.0043', usdPrice: 0.0043, currencyPrice: 0.0043, currencySymbol: '$' },
    ],
  },
};
const product = parseLcscProduct(C1591) as LcscProduct;

describe('parseLcscProduct', () => {
  it("reads LCSC's product detail, with the price ladder in order", () => {
    expect(product).toEqual({
      partNumber: 'C1591', mpn: 'CL10B104KB8NNNC', manufacturer: 'Samsung Electro-Mechanics', currency: 'USD',
      priceBreaks: [{ qty: 100, price: 0.0085 }, { qty: 1000, price: 0.0064 }, { qty: 4000, price: 0.0055 }, { qty: 100000, price: 0.0043 }],
      stock: 1175100, productUrl: 'https://www.lcsc.com/product-detail/C1591.html',
    });
  });

  it("says nothing for a part number LCSC doesn't know", () => {
    expect(parseLcscProduct({ code: 200, msg: null, result: null, ok: true })).toBeNull();
  });

  it('uses the shown price and currency when there is no dollar price, and drops broken breaks', () => {
    const p = parseLcscProduct({ result: { productCode: 'c42', currencyType: 'EUR', productPriceList: [{ ladder: 10, currencyPrice: 0.5 }, { ladder: 1, currencyPrice: 0 }, { ladder: 'x', currencyPrice: 1 }] } });

    expect(p).toMatchObject({ partNumber: 'C42', currency: 'EUR', priceBreaks: [{ qty: 10, price: 0.5 }], stock: null, mpn: null });
  });
});

describe('lcscPriceAt', () => {
  it('prices an order at the largest break it reaches', () => {
    expect(lcscPriceAt(product.priceBreaks, 1000)).toEqual({ price: 0.0064, breakQty: 1000 });
    expect(lcscPriceAt(product.priceBreaks, 999)).toEqual({ price: 0.0085, breakQty: 100 });
    expect(lcscPriceAt(product.priceBreaks, 250000)).toEqual({ price: 0.0043, breakQty: 100000 });
    // Below the minimum order, the smallest break is what LCSC sells.
    expect(lcscPriceAt(product.priceBreaks, 1)).toEqual({ price: 0.0085, breakQty: 100 });
    expect(lcscPriceAt([], 1000)).toBeNull();
  });
});

describe('lookupLcsc', () => {
  function fakeDeps({ rows: initialRows, usedToday, ...over }: Partial<LcscDeps> & { rows?: Record<string, any>; usedToday?: number } = {}) {
    const rows: Record<string, any> = { ...(initialRows ?? {}) };
    const calls = { fetched: [] as string[], counted: 0, saved: [] as LcscProduct[] };
    let usage = usedToday ?? 0;
    const deps: LcscDeps = {
      cached: async (pn) => rows[pn] ?? Object.values(rows).find((r: any) => r.mpn === pn) ?? null,
      save: async (p) => { calls.saved.push(p); rows[p.partNumber] = { part_number: p.partNumber, mpn: p.mpn, manufacturer: p.manufacturer, price: p.priceBreaks[0]?.price ?? null, currency: p.currency, stock: p.stock, url: p.productUrl, price_breaks: p.priceBreaks, updated_at: new Date(NOW).toISOString() }; },
      fetchProduct: async (code) => { calls.fetched.push(code); return code === 'C1591' ? product : null; },
      usage: async () => usage,
      countUsage: async () => { calls.counted += 1; usage += 1; },
      now: () => NOW,
      ...over,
    };
    return { deps, rows, calls };
  }

  it('asks LCSC once, keeps the whole ladder, and prices any quantity from it', async () => {
    const { deps, calls } = fakeDeps();

    const first = await lookupLcsc('c1591 ', 1000, 30 * DAY, deps);
    const second = await lookupLcsc('C1591', 100, 30 * DAY, deps);

    expect(first).toEqual({ partNumber: 'C1591', mpn: 'CL10B104KB8NNNC', manufacturer: 'Samsung Electro-Mechanics', unitPrice: 0.0064, breakQuantity: 1000,
      currency: 'USD', stock: 1175100, productUrl: 'https://www.lcsc.com/product-detail/C1591.html' });
    expect(second).toMatchObject({ unitPrice: 0.0085, breakQuantity: 100, updatedAt: new Date(NOW).toISOString() });
    expect(calls.fetched).toEqual(['C1591']);
    expect(calls.counted).toBe(1);
  });

  it('asks again once the cached answer is older than allowed', async () => {
    const { deps, calls } = fakeDeps({ rows: { C1591: { part_number: 'C1591', price: '0.0100', currency: 'USD', price_breaks: [{ qty: 1, price: 0.01 }], updated_at: new Date(NOW - 31 * DAY).toISOString() } } });

    const result = await lookupLcsc('C1591', 1000, 30 * DAY, deps);

    expect(result).toMatchObject({ unitPrice: 0.0064 });
    expect(calls.fetched).toEqual(['C1591']);
  });

  it('falls back to an older price when LCSC cannot be reached, and says why when there is none', async () => {
    const old = { part_number: 'C1591', price: '0.0100', currency: 'USD', price_breaks: null, updated_at: new Date(NOW - 60 * DAY).toISOString() };
    const failing = { fetchProduct: async () => { throw new Error('LCSC lookup failed: 503'); } };

    expect(await lookupLcsc('C1591', 1000, 30 * DAY, fakeDeps({ ...failing, rows: { C1591: old } }).deps)).toMatchObject({ unitPrice: 0.01 });
    expect(await lookupLcsc('C1591', 1000, 30 * DAY, fakeDeps(failing).deps)).toEqual({ error: 'LCSC lookup failed: 503' });
  });

  it("reports a part number LCSC doesn't know, and one it lists without a price", async () => {
    expect(await lookupLcsc('C999999999', 1000, 30 * DAY, fakeDeps().deps)).toEqual({ error: 'No match found' });

    const unpriced = fakeDeps({ fetchProduct: async () => ({ ...product, priceBreaks: [] }) });
    expect(await lookupLcsc('C1591', 1000, 30 * DAY, unpriced.deps)).toMatchObject({ unitPrice: null, error: 'Listed, but LCSC shows no price' });
  });

  it('stops at the daily limit', async () => {
    const { deps, calls } = fakeDeps({ usedToday: 1000 });

    expect(await lookupLcsc('C1591', 1000, 30 * DAY, deps)).toEqual({ error: 'Daily limit reached' });
    expect(calls.fetched).toEqual([]);
  });

  it('uses an imported price for a manufacturer part number at any age, and otherwise does not ask LCSC', async () => {
    const imported = { part_number: 'C2040', mpn: 'RP2040', price: '0.7268', currency: 'USD', price_breaks: null, updated_at: new Date(NOW - 400 * DAY).toISOString() };
    const withImport = fakeDeps({ rows: { C2040: imported } });

    expect(await lookupLcsc('RP2040', 1000, 30 * DAY, withImport.deps)).toMatchObject({ partNumber: 'C2040', mpn: 'RP2040', unitPrice: 0.7268 });
    expect(withImport.calls.fetched).toEqual([]);

    const bare = fakeDeps();
    expect(await lookupLcsc('CL10B104KB8NNNC', 1000, 30 * DAY, bare.deps)).toEqual({ error: 'Skipped: LCSC is only looked up by its own part number (C…)' });
    expect(bare.calls.fetched).toEqual([]);
  });
});

describe('quotePart and LCSC', () => {
  function quoteDeps(over: Partial<QuoteDeps> = {}) {
    const asked = { lcsc: [] as string[], providers: [] as string[], findLcscCode: [] as string[] };
    const deps: QuoteDeps = {
      isConfigured: async () => true,
      digikeyAuthorized: async () => true,
      lookup: (async (provider: string, partNumber: string) => { asked.providers.push(`${provider}:${partNumber}`); return { result: { error: 'No match found' }, fromCache: false, calledApi: true }; }) as any,
      lcsc: async (pn) => { asked.lcsc.push(pn); return { partNumber: pn, unitPrice: 0.0064, currency: 'USD' }; },
      skuToPartNumber: async (sku) => (sku === 'CAP-009' ? { sku: 'CAP-009', name: '100nF', partNumber: 'CL10B104KB8NNNC', lcscCode: 'C1591' } : null),
      findLcscCode: async (pn) => { asked.findLcscCode.push(pn); return pn === 'CL10B104KB8NNNC' ? 'C1591' : null; },
      ...over,
    };
    return { deps, asked };
  }

  it("asks LCSC by the item's LCSC number, and the others by the part number", async () => {
    const { deps, asked } = quoteDeps();

    const quote = await quotePart('CL10B104KB8NNNC', 1000, DAY, { lcscCode: 'C1591' }, deps);

    expect(asked.lcsc).toEqual(['C1591']);
    expect(asked.providers).toEqual(['digikey:CL10B104KB8NNNC', 'mouser:CL10B104KB8NNNC', 'nexar:CL10B104KB8NNNC', 'element14:CL10B104KB8NNNC', 'tme:CL10B104KB8NNNC']);
    expect(asked.findLcscCode).toEqual([]);
    expect(quote).toMatchObject({ partNumber: 'CL10B104KB8NNNC', codeFormat: 'mfn', lcscCode: 'C1591', lcsc: { unitPrice: 0.0064 } });
  });

  it('looks up the LCSC number from inventory when the caller does not give one', async () => {
    const { deps, asked } = quoteDeps();

    const quote = await quotePart('CL10B104KB8NNNC', 1000, DAY, {}, deps);

    expect(asked.findLcscCode).toEqual(['CL10B104KB8NNNC']);
    expect(asked.lcsc).toEqual(['C1591']);
    expect(quote.lcscCode).toBe('C1591');
  });

  it('does not look one up when the caller knows there is none', async () => {
    const { deps, asked } = quoteDeps();

    const quote = await quotePart('HX20007-5AWB', 1000, DAY, { lcscCode: null }, deps);

    expect(asked.findLcscCode).toEqual([]);
    expect(asked.lcsc).toEqual(['HX20007-5AWB']);
    expect(quote.lcscCode).toBeUndefined();
  });

  it('sends an LCSC number to LCSC alone', async () => {
    const { deps, asked } = quoteDeps();

    const quote = await quotePart('c1591', 1000, DAY, { lcscCode: 'C9999' }, deps);

    expect(asked.lcsc).toEqual(['C1591']);
    expect(asked.providers).toEqual([]);
    expect(quote).toMatchObject({ codeFormat: 'lcsc', mouser: { error: 'Skipped: LCSC-format code — this distributor does not recognise it' } });
    expect(quote.lcscCode).toBeUndefined();
  });

  it("translates a stock code to the item's part number and LCSC number", async () => {
    const { deps, asked } = quoteDeps();

    const quote = await quotePart('CAP-009', 1000, DAY, { resolveSku: true }, deps);

    expect(quote).toMatchObject({ partNumber: 'CL10B104KB8NNNC', searchedFor: 'CAP-009', resolvedFromSku: { sku: 'CAP-009', name: '100nF' }, lcscCode: 'C1591' });
    expect(asked.lcsc).toEqual(['C1591']);
    expect(asked.findLcscCode).toEqual([]);
  });
});

describe('pickPartNumbers', () => {
  // man_pn_1..5, then sup_pn_1..5
  const fields = (man: Array<string | null>, sup: Array<string | null> = []) =>
    [...man, ...Array(5 - man.length).fill(null), ...sup, ...Array(5 - sup.length).fill(null)];

  it('takes the first real part number, manufacturer fields first', () => {
    expect(pickPartNumbers(fields(['N/A', ' HX20007-5AWB '], ['595-SN65HVD232DR']))).toEqual({ partNumber: 'HX20007-5AWB', lcscCode: null });
    expect(pickPartNumbers(fields([], ['595-SN65HVD232DR']))).toEqual({ partNumber: '595-SN65HVD232DR', lcscCode: null });
  });

  it('never uses placeholders or supplier names', () => {
    expect(pickPartNumbers(fields(['Generic', 'NOT ASSIGNED', '0'], ['Digikey', 'LCSC', 'MICRO ROBOTICS', 'COMMUNICA']))).toEqual({ partNumber: null, lcscCode: null });
  });

  it('keeps the LCSC number apart, and prices by it only when there is nothing else', () => {
    expect(pickPartNumbers(fields(['N/A', null, 'c1591'], ['CL10B104KB8NNNC']))).toEqual({ partNumber: 'CL10B104KB8NNNC', lcscCode: 'C1591' });
    expect(pickPartNumbers(fields(['N/A', null, 'C1591'], ['Digikey']))).toEqual({ partNumber: 'C1591', lcscCode: 'C1591' });
  });
});
