import { describe, expect, it } from 'vitest';
import { alignItem, linkSupplier, sameSlots } from './partAlign';

const DK = 'https://www.digikey.co.za/en/products/detail/fremont-micro-devices-ltd/FT24C08A-ELR-T/7795347';
const LC = 'https://www.lcsc.com/product-detail/EEPROM_FMD-Fremont-Micro-Devices-FT24C08A-ELR-T_C232869.html';

describe('linkSupplier', () => {
  it('tells whose page a link is', () => {
    expect([DK, LC, 'https://www.mouser.co.za/ProductDetail/x', 'https://example.com/a', 'N/A', ''].map(linkSupplier))
      .toEqual(['digikey', 'lcsc', 'mouser', 'other', null, null]);
  });
});

describe('alignItem', () => {
  it('lines up CHP-021: links and part numbers in their supplier slots, N/A where a supplier has nothing', () => {
    const { slots, notes } = alignItem(
      { man: ['', '', '', '', ''], sup: ['', '1219-1233-2-ND', 'C232869', '', ''], web: [DK, LC, '', '', ''] },
      { mouser: { status: 'none' }, digikey: { status: 'found', mpn: 'FT24C08A-ELR-T' }, lcsc: { status: 'found', mpn: 'FT24C08A-ELR-T', supplierPn: 'C232869' } },
    );
    expect(notes).toEqual([]);
    expect(slots).toEqual({
      man: ['N/A', 'FT24C08A-ELR-T', 'FT24C08A-ELR-T', 'N/A', 'N/A'],
      sup: ['N/A', '1219-1233-2-ND', 'C232869', 'N/A', 'N/A'],
      web: ['N/A', DK, LC, 'N/A', 'N/A'],
    });
  });

  it('lines up CHP-027: a manufacturer number no supplier slot needs is kept, not lost', () => {
    const { slots } = alignItem(
      { man: ['USB2517I-JZX-TR', 'N/A', 'USB2517I-JZX-TR', 'N/A', 'N/A'], sup: ['N/A', 'N/A', 'C626667', 'N/A', 'N/A'],
        web: ['N/A', 'N/A', 'https://www.lcsc.com/product-detail/C626667.html', 'N/A', 'N/A'] },
      { mouser: { status: 'none' }, digikey: { status: 'none' }, lcsc: { status: 'found', mpn: 'USB2517I-JZX-TR', supplierPn: 'C626667' } },
    );
    expect(slots.man).toEqual(['N/A', 'N/A', 'USB2517I-JZX-TR', 'N/A', 'N/A']);
    expect(slots.sup).toEqual(['N/A', 'N/A', 'C626667', 'N/A', 'N/A']);
  });

  it('moves a manufacturer number no supplier gave to slot 4, and keeps a slot whose supplier couldn\'t be asked', () => {
    const { slots } = alignItem(
      { man: ['OLD-MPN-1', 'DK-MPN', '', '', ''], sup: ['', '296-1-ND', '', '', ''], web: ['', '', '', '', ''] },
      { mouser: { status: 'none' }, digikey: { status: 'error', message: '401' }, lcsc: { status: 'none' } },
    );
    expect(slots.man).toEqual(['N/A', 'DK-MPN', 'N/A', 'OLD-MPN-1', 'N/A']);
  });

  it('drops a copy of a supplier number from the manufacturer slots, and puts extra links in 4-5', () => {
    const { slots } = alignItem(
      { man: ['CL10B104', '311-1188-2-ND', 'C107096', '', ''], sup: ['603-CL10B104', '311-1188-2-ND', 'C107096', '', ''],
        web: ['https://example.com/ds.pdf', 'https://www.mouser.com/ProductDetail/a', 'https://www.mouser.com/ProductDetail/b', '', ''] },
      { mouser: { status: 'found', mpn: 'CL10B104' }, digikey: { status: 'found', mpn: 'CL10B104' }, lcsc: { status: 'found', mpn: 'CL10B104' } },
    );
    expect(slots.man).toEqual(['CL10B104', 'CL10B104', 'CL10B104', 'N/A', 'N/A']);
    expect(slots.web).toEqual(['https://www.mouser.com/ProductDetail/a', 'N/A', 'N/A', 'https://example.com/ds.pdf', 'https://www.mouser.com/ProductDetail/b']);
  });

  it('leaves a list alone when the extras don\'t fit', () => {
    const web = ['https://a.com/1', 'https://a.com/2', 'https://a.com/3', 'https://a.com/4', 'https://www.lcsc.com/product-detail/C1.html'];
    const { slots, notes } = alignItem({ man: [], sup: [], web }, {});
    expect(slots.web).toEqual(web);
    expect(notes).toEqual(['More web links than slots: left as they are.']);
  });

  it('compares slots ignoring how "none" is written', () => {
    expect(sameSlots({ man: ['', 'NA'], sup: [], web: [] }, { man: ['N/A', 'N/A', 'N/A', 'N/A', 'N/A'], sup: ['N/A', '', '', '', ''], web: ['-'] })).toBe(true);
  });
});
