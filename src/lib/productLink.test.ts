import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({
  pool: { connect: async () => { throw new Error('no database in tests'); } },
  query: async () => { throw new Error('no database in tests'); },
  queryOne: async () => null,
  exec: async () => {},
}));

import { applyFill, fillOptions, parseProductLink, type ProductDetails } from './productLink';
import { lcscDetails } from './pricingRoutes';

// LCSC's answer for C365814 (trimmed to the fields used), as it came on 2026-10-12.
const LCSC_C365814 = {
  result: {
    productCode: 'C365814', productModel: 'FM31X104K251EEG', brandNameEn: 'PSA', encapStandard: '1206',
    productIntroEn: '100nF ±10% 250V Ceramic Capacitor X7R 1206',
    pdfUrl: 'https://datasheet.lcsc.com/datasheet/pdf/8aced6bf.pdf?productCode=C365814',
    paramVOList: [
      { paramNameEn: 'Capacitance', paramValueEn: '100nF' }, { paramNameEn: 'Temperature Coefficient', paramValueEn: 'X7R' },
      { paramNameEn: 'Tolerance', paramValueEn: '±10%' }, { paramNameEn: 'Voltage Rating', paramValueEn: '250V' },
    ],
  },
};

describe('parseProductLink', () => {
  it.each([
    ['https://www.lcsc.com/product-detail/Multilayer-Ceramic-Capacitors-MLCC-SMD-SMT_PSA-FM31X104K251EEG_C365814.html', { supplier: 'lcsc', lcscCode: 'C365814' }],
    ['lcsc.com/product-detail/C1591.html', { supplier: 'lcsc', lcscCode: 'C1591' }],
    ['https://www.digikey.co.za/en/products/detail/psa-walsin-technology/FM31X104K251EEGTR/16590331', { supplier: 'digikey', manufacturer: 'psa walsin technology', mpn: 'FM31X104K251EEGTR' }],
    ['https://www.mouser.co.za/ProductDetail/KEMET/C0805C152J1RACTU?qs=abc', { supplier: 'mouser', manufacturer: 'KEMET', mpn: 'C0805C152J1RACTU' }],
    ['https://www.mouser.com/ProductDetail/581-08051C104KAT2A', { supplier: 'mouser', mpn: '581-08051C104KAT2A' }],
  ])('reads %s', (url, expected) => {
    expect(parseProductLink(url)).toEqual(expected);
  });

  it.each([['https://www.lcsc.com/'], ['https://example.com/C1591.html'], ['not a link at all'], ['']])('ignores %j', (url) => {
    expect(parseProductLink(url)).toBeNull();
  });
});

describe('lcscDetails', () => {
  it("reads LCSC's answer", () => {
    expect(lcscDetails(LCSC_C365814)).toEqual({
      supplier: 'lcsc', supplierName: 'LCSC', supplierPartNumber: 'C365814', manufacturerPartNumber: 'FM31X104K251EEG', manufacturer: 'PSA',
      description: '100nF ±10% 250V Ceramic Capacitor X7R 1206', value: '100nF', tolerance: '±10%', package: '1206',
      datasheet: 'https://datasheet.lcsc.com/datasheet/pdf/8aced6bf.pdf?productCode=C365814',
      extra: [{ name: 'Temperature Coefficient', value: 'X7R' }, { name: 'Voltage Rating', value: '250V' }],
    });
    expect(lcscDetails({ result: null })).toBeNull();
  });
});

describe('the checklist', () => {
  const details = lcscDetails(LCSC_C365814) as ProductDetails;
  const item = {
    description: '', value: '100nF', tolerance: '', packageName: '0603', size: '', datasheet: '', supplier: 'N/A',
    manPns: ['', 'FM31X104K251EEG', '', '', ''], supPns: ['5440-FM31X104K251EEGTR-ND', '', '', '', ''],
  };

  it('ticks empty fields, offers different ones unticked, and leaves out what the item already has', () => {
    expect(fillOptions(item, details).map((o) => [o.label, o.value, o.current, o.checked])).toEqual([
      ['Description', '100nF ±10% 250V Ceramic Capacitor X7R 1206', '', true],
      ['Tolerance', '±10%', '', true],
      ['Package', '1206', '0603', false],
      ['Size', '1206', '', true],
      ['Datasheet', details.datasheet, '', true],
      ['Preferred supplier', 'LCSC', '', true],
      ['LCSC PN (Sup PN 3)', 'C365814', '', true],
    ]); // Value matches; the manufacturer PN is already in Mfr PN 2
  });

  it('fills in only the ticked lines, part numbers in their slots', () => {
    const options = fillOptions(item, details);
    const chosen = options.filter((o) => ['Tolerance', 'LCSC PN (Sup PN 3)', 'Package'].includes(o.label));
    expect(applyFill(item, details, chosen)).toEqual({
      tolerance: '±10%', packageName: '1206',
      supPns: ['5440-FM31X104K251EEGTR-ND', '', 'C365814', '', ''],
    });
    const fresh = fillOptions({}, details).find((o) => o.field === 'manPn')!;
    expect(applyFill({}, details, [fresh])).toEqual({ manPns: ['FM31X104K251EEG', '', '', '', ''], manufacturer: 'FM31X104K251EEG' });
  });
});
