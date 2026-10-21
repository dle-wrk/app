import { describe, expect, it } from 'vitest';
import { atNoSupplier, orderCsv, supplierNumberFor, supplierOrders } from './supplierBom';

describe('supplierNumberFor', () => {
  it("takes the supplier's slot, else a number plainly theirs in another slot, never a placeholder", () => {
    expect(supplierNumberFor(['81-GRM188', '490-1-ND', 'C1591', 'N/A', 'N/A'], 'mouser')).toBe('81-GRM188');
    expect(supplierNumberFor(['N/A', 'N/A', 'N/A', 'C1591', ''], 'lcsc')).toBe('C1591'); // in slot 4
    expect(supplierNumberFor(['C1591', '', '', '', ''], 'mouser')).toBe(''); // an LCSC number isn't Mouser's
    expect(supplierNumberFor(['N/A', 'Digikey', '', '', ''], 'digikey')).toBe(''); // a name, not a number
    expect(supplierNumberFor(undefined, 'lcsc')).toBe('');
  });
});

describe('supplierOrders', () => {
  const lines = [
    { stockCode: 'CAP-001', description: '100nF, X7R', footprint: '0603', supPns: ['187-CL10B104', '1276-1000-1-ND', 'C1591'], qty: 50 },
    { stockCode: 'CAP-002', description: '100nF reel 2', footprint: '0603', supPns: ['N/A', 'N/A', 'C1591'], qty: 20 }, // same LCSC part
    { stockCode: 'CHP-027', description: 'USB hub', footprint: 'QFN-36', supPns: ['N/A', 'N/A', 'C626667'], qty: 5 },
    { stockCode: 'MEC-001', description: 'Bracket', footprint: '', supPns: ['N/A', 'N/A', 'N/A'], qty: 2 },
    { stockCode: 'RES-001', description: '10k', footprint: '0603', supPns: ['', '', 'C25804'], qty: 0 }, // nothing to order
  ];

  it('one order per supplier, adding up the same number, listing what each lacks', () => {
    const [mouser, digikey, lcsc] = supplierOrders(lines);
    expect(mouser.rows).toEqual([{ supplierPn: '187-CL10B104', qty: 50, description: '100nF, X7R', footprint: '0603', stockCodes: ['CAP-001'] }]);
    expect(mouser.missing).toEqual(['CAP-002', 'CHP-027', 'MEC-001']);
    expect(digikey.rows.map((r) => r.supplierPn)).toEqual(['1276-1000-1-ND']);
    expect(lcsc.rows.map((r) => [r.supplierPn, r.qty, r.stockCodes])).toEqual([['C1591', 70, ['CAP-001', 'CAP-002']], ['C626667', 5, ['CHP-027']]]);
    expect(atNoSupplier([mouser, digikey, lcsc])).toEqual(['MEC-001']);
  });

  it("writes each supplier's upload format", () => {
    const [mouser, digikey, lcsc] = supplierOrders(lines);
    expect(orderCsv('mouser', mouser.rows)).toBe('187-CL10B104|50\n');
    expect(orderCsv('digikey', digikey.rows)).toBe('Quantity,Part Number\n50,"1276-1000-1-ND"\n');
    expect(orderCsv('lcsc', lcsc.rows)).toBe('Comment,Designator,Footprint,LCSC Part #,Quantity\n"100nF  X7R","","0603","C1591",70\n"USB hub","","QFN-36","C626667",5\n');
  });
});
