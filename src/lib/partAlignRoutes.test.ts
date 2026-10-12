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

const DK = 'https://www.digikey.co.za/en/products/detail/fremont-micro-devices-ltd/FT24C08A-ELR-T/7795347';
const LC = 'https://www.lcsc.com/product-detail/EEPROM_FMD-Fremont-Micro-Devices-FT24C08A-ELR-T_C232869.html';

const fakes = (over: Partial<AlignDeps> = {}) => {
  const asked: string[] = [];
  const deps: AlignDeps = {
    lcsc: async (c) => { asked.push(`lcsc ${c}`); return c === 'C232869' ? 'FT24C08A-ELR-T' : c === 'C626667' ? 'USB2517I-JZX-TR' : null; },
    mouser: async (k) => { asked.push(`mouser ${k}`); return null; },
    digikey: async (pn) => { asked.push(`digikey ${pn}`); return 'FROM-API'; },
    pause: async () => {},
    ...over,
  };
  return { deps, asked };
};

describe('findForItem', () => {
  it('CHP-021: reads DigiKey from its link, asks LCSC by its number, and Mouser not at all', async () => {
    const slots = { man: ['', '', '', '', ''], sup: ['', '1219-1233-2-ND', 'C232869', '', ''], web: [DK, LC, '', '', ''] };
    const { deps, asked } = fakes();
    const found = await findForItem(slots, deps);
    expect(asked).toEqual(['lcsc C232869']);
    expect(found).toEqual({
      lcsc: { status: 'found', mpn: 'FT24C08A-ELR-T', supplierPn: 'C232869' },
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
    expect(after.web).toEqual(['N/A', 'N/A', 'N/A', 'N/A', 'N/A']);
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
