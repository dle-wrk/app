import { describe, expect, it, vi } from 'vitest';

// The routes import ./db, which refuses to load without DATABASE_URL (CI has none).
vi.mock('./db', () => ({
  pool: { connect: async () => { throw new Error('no database in tests'); } },
  query: async () => { throw new Error('no database in tests'); },
  queryOne: async () => null,
  exec: async () => {},
}));

import { findForItem, type AlignDeps } from './partAlignRoutes';
import { alignItem } from './partAlign';
import { pickLcscMatch } from './pricingRoutes';

const DK = 'https://www.digikey.co.za/en/products/detail/fremont-micro-devices-ltd/FT24C08A-ELR-T/7795347';
const LC = 'https://www.lcsc.com/product-detail/EEPROM_FMD-Fremont-Micro-Devices-FT24C08A-ELR-T_C232869.html';

const fakes = (over: Partial<AlignDeps> = {}) => {
  const asked: string[] = [];
  const deps: AlignDeps = {
    lcsc: async (c) => { asked.push(`lcsc ${c}`); return c === 'C232869' ? 'FT24C08A-ELR-T' : c === 'C626667' ? 'USB2517I-JZX-TR' : null; },
    mouser: async (k) => { asked.push(`mouser ${k}`); return null; },
    digikey: async (pn) => { asked.push(`digikey ${pn}`); return 'FROM-API'; },
    mouserFind: async (m) => { asked.push(`mouserFind ${m}`); return null; },
    digikeyFind: async (m) => { asked.push(`digikeyFind ${m}`); return null; },
    lcscFind: async (m) => { asked.push(`lcscFind ${m}`); return null; },
    pause: async () => {},
    ...over,
  };
  return { deps, asked };
};

describe('filling a supplier the item has nothing of', () => {
  it('CHP-027: searches Mouser and DigiKey for the part LCSC gave, and fills their three slots', async () => {
    const slots = { man: ['USB2517I-JZX-TR', 'N/A', 'USB2517I-JZX-TR', 'N/A', 'N/A'], sup: ['N/A', 'N/A', 'C626667', 'N/A', 'N/A'], web: ['N/A', 'N/A', 'https://www.lcsc.com/product-detail/C626667.html', 'N/A', 'N/A'] };
    const { deps, asked } = fakes({
      mouserFind: async (m) => { asked.push(`mouserFind ${m}`); return { mpn: 'USB2517I-JZX-TR', supplierPn: '886-USB2517I-JZX-TR', url: 'https://www.mouser.co.za/ProductDetail/Microchip-Technology/USB2517I-JZX-TR' }; },
      digikeyFind: async (m) => { asked.push(`digikeyFind ${m}`); return { mpn: 'USB2517I-JZX-TR', supplierPn: 'USB2517I-JZX-CT-ND', url: 'https://www.digikey.co.za/en/products/detail/microchip-technology/USB2517I-JZX-TR/1234' }; },
    });
    const found = await findForItem(slots, deps);
    expect(asked).toEqual(['lcsc C626667', 'mouserFind USB2517I-JZX-TR', 'digikeyFind USB2517I-JZX-TR']);
    expect(found.mouser).toMatchObject({ status: 'found', discovered: true, supplierPn: '886-USB2517I-JZX-TR' });
    const { slots: after, notes } = alignItem(slots, found);
    expect(notes).toEqual([]);
    expect(after.man).toEqual(['USB2517I-JZX-TR', 'USB2517I-JZX-TR', 'USB2517I-JZX-TR', 'N/A', 'N/A']);
    expect(after.sup).toEqual(['886-USB2517I-JZX-TR', 'USB2517I-JZX-CT-ND', 'C626667', 'N/A', 'N/A']);
    expect(after.web.slice(0, 3).map((u) => u.split('/')[2])).toEqual(['www.mouser.co.za', 'www.digikey.co.za', 'www.lcsc.com']);
  });

  it('searches by a part number in Mfr PN when no supplier gave one, but not by a supplier number', async () => {
    const slots = { man: ['C107096', 'CL10B104KB8NNNC', '', '', ''], sup: ['', '', '', '', ''], web: ['', '', '', '', ''] };
    const { deps, asked } = fakes({ lcsc: async (c) => { asked.push(`lcsc ${c}`); return null; } });
    await findForItem(slots, deps);
    expect(asked).toEqual(['lcsc C107096', 'mouserFind CL10B104KB8NNNC', 'digikeyFind CL10B104KB8NNNC', 'lcscFind CL10B104KB8NNNC']);
  });

  it('keeps the slot as it is when the search fails, and searches nothing without a part number', async () => {
    const slots = { man: ['BSS138', '', '', '', ''], sup: ['', '', '', '', ''], web: ['', '', '', '', ''] };
    const { deps } = fakes({ mouserFind: async () => { throw new Error('429 Too Many Requests'); } });
    const found = await findForItem(slots, deps);
    expect(found.mouser).toEqual({ status: 'error', message: '429 Too Many Requests' });
    expect(alignItem(slots, found).slots.man[0]).toBe('BSS138'); // kept, not N/A
    const none = fakes();
    await findForItem({ man: ['', '', '', '', ''], sup: ['', '', '', '', ''], web: ['', '', '', '', ''] }, none.deps);
    expect(none.asked).toEqual([]);
  });
});

describe('finding an item at LCSC', () => {
  it('CHP-032: searches LCSC for the part when the item has no LCSC number, and fills slot 3', async () => {
    const slots = { man: ['TLV70233DBVT', '', '', '', ''], sup: ['', '', '', '', ''], web: ['', '', '', '', ''] };
    const { deps, asked } = fakes({ lcscFind: async (m) => { asked.push(`lcscFind ${m}`); return { mpn: 'TLV70233DBVT', supplierPn: 'C110287', url: 'https://www.lcsc.com/product-detail/C110287.html' }; } });
    const found = await findForItem(slots, deps);
    expect(asked).toEqual(['mouserFind TLV70233DBVT', 'digikeyFind TLV70233DBVT', 'lcscFind TLV70233DBVT']);
    expect(found.lcsc).toEqual({ status: 'found', mpn: 'TLV70233DBVT', supplierPn: 'C110287', link: 'https://www.lcsc.com/product-detail/C110287.html', discovered: true });
    const { slots: after } = alignItem(slots, found);
    expect([after.man[2], after.sup[2], after.web[2]]).toEqual(['TLV70233DBVT', 'C110287', 'https://www.lcsc.com/product-detail/C110287.html']);
  });

  it('takes only the exact part from a real maker, in stock first', () => {
    const list = [
      { componentCode: 'C2937041', componentModelEn: 'TPTLV70233DBVR', componentBrandEn: 'TECH PUBLIC', stockCount: 1136 },
      { componentCode: 'C9900008356', componentModelEn: 'TLV70233DBVT', componentBrandEn: 'JLCPCB Assembly', stockCount: 9999 },
      { componentCode: 'C110287', componentModelEn: 'TLV70233DBVT', componentBrandEn: 'Texas Instruments', stockCount: 210 },
      { componentCode: 'C5', componentModelEn: 'tlv70233dbvt ', componentBrandEn: 'Texas Instruments', stockCount: 0 },
    ];
    expect(pickLcscMatch(list, 'TLV70233DBVT')).toBe('C110287');
    expect(pickLcscMatch(list.slice(0, 2), 'TLV70233DBVT')).toBeNull();
    expect(pickLcscMatch(null as any, 'X')).toBeNull();
  });
});

describe('JLCPCB links and LCSC numbers', () => {
  it("reads the LCSC number from a JLCPCB link, and gives an item with only an LCSC number LCSC's page", async () => {
    const JLC = 'https://jlcpcb.com/partdetail/HJTech-HJ_2_4GHzSMA/C1509156';
    const slots = { man: ['', '', '', '', ''], sup: ['', '', '', '', ''], web: ['', '', '', JLC, ''] };
    const { deps, asked } = fakes({ lcsc: async (c) => { asked.push(`lcsc ${c}`); return 'HJ-2.4GHz-SMA'; } });
    const found = await findForItem(slots, deps);
    expect(asked[0]).toBe('lcsc C1509156');
    const { slots: after } = alignItem(slots, found);
    expect(after.sup[2]).toBe('C1509156');
    expect(after.man[2]).toBe('HJ-2.4GHz-SMA');
    expect(after.web[2]).toBe('https://www.lcsc.com/product-detail/C1509156.html');
    expect(after.web[3]).toBe(JLC); // the JLCPCB page stays, in an "other" slot
  });
});

describe('findForItem', () => {
  it('CHP-021: reads DigiKey from its link, asks LCSC by its number, and searches Mouser for the part', async () => {
    const slots = { man: ['', '', '', '', ''], sup: ['', '1219-1233-2-ND', 'C232869', '', ''], web: [DK, LC, '', '', ''] };
    const { deps, asked } = fakes();
    const found = await findForItem(slots, deps);
    expect(asked).toEqual(['lcsc C232869', 'mouserFind FT24C08A-ELR-T']); // Mouser hasn't got it
    expect(found).toEqual({
      lcsc: { status: 'found', mpn: 'FT24C08A-ELR-T', supplierPn: 'C232869', link: 'https://www.lcsc.com/product-detail/C232869.html' },
      digikey: { status: 'found', mpn: 'FT24C08A-ELR-T' },
      mouser: { status: 'none' },
    });
    expect(alignItem(slots, found).slots.man).toEqual(['N/A', 'FT24C08A-ELR-T', 'FT24C08A-ELR-T', 'N/A', 'N/A']);
  });

  it('CHP-027: finds the LCSC number in the Supplier field values and fills N/A elsewhere', async () => {
    const slots = { man: ['USB2517I-JZX-TR', 'N/A', 'USB2517I-JZX-TR', 'N/A', 'N/A'], sup: ['N/A', 'N/A', 'C626667', 'N/A', 'N/A'], web: ['N/A', 'N/A', 'N/A', 'N/A', 'N/A'] };
    const { deps } = fakes();
    const { slots: after } = alignItem(slots, await findForItem(slots, deps));
    expect(after.man).toEqual(['N/A', 'N/A', 'USB2517I-JZX-TR', 'N/A', 'N/A']);
    expect(after.web).toEqual(['N/A', 'N/A', 'https://www.lcsc.com/product-detail/C626667.html', 'N/A', 'N/A']); // LCSC's page, from its number
  });

  it('asks DigiKey by its number without a link, and reports a supplier it could not ask', async () => {
    const slots = { man: ['', '', '', '', ''], sup: ['', '296-1-ND', '', '', ''], web: ['', '', '', '', ''] };
    const { deps, asked } = fakes({ digikey: async () => { throw new Error('401 Unauthorized'); } });
    const found = await findForItem(slots, deps);
    expect(asked).toEqual([]);
    expect(found.digikey).toEqual({ status: 'error', message: '401 Unauthorized' });
  });

  it('asks Mouser by its number and takes its number back', async () => {
    const slots = { man: ['', '', '', '', ''], sup: ['81-GRM188R71H104KA3D', '', '', '', ''], web: ['', '', '', '', ''] };
    const { deps } = fakes({ mouser: async () => ({ mpn: 'GRM188R71H104KA93D', mouserPn: '81-GRM188R71H104KA3D' }) });
    expect((await findForItem(slots, deps)).mouser).toEqual({ status: 'found', mpn: 'GRM188R71H104KA93D', supplierPn: '81-GRM188R71H104KA3D' });
  });
});
