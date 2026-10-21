import { describe, expect, it } from 'vitest';
import { bestPackaging, priceLadder, type Ladder } from './supplierQuotes';
import { orderCsv, plainText, supplierOrders } from './supplierBom';

// From TCU06's 50-board shortages: 389 x 10k 0603.
const lcsc10k: Ladder = { supplierPn: 'C98220', currency: 'USD', breaks: [{ qty: 100, price: 0.0006 }, { qty: 1000, price: 0.0004 }], moq: 100, mult: 100, stock: 2139000 };
const reel: Ladder = { supplierPn: '311-10.0KHRTR-ND', currency: 'ZAR', breaks: [{ qty: 5000, price: 0.03 }], moq: 5000, mult: 1, stock: 900000, packaging: 'Tape & Reel (TR)' };
const cutTape: Ladder = { supplierPn: '311-10.0KHRCT-ND', currency: 'ZAR', breaks: [{ qty: 1, price: 1.7 }, { qty: 10, price: 0.6 }, { qty: 100, price: 0.2 }], moq: 1, mult: 1, stock: 400000, packaging: 'Cut Tape (CT)' };

describe("each supplier's rules", () => {
  it('LCSC: 389 becomes 400, its step of 100', () => {
    expect(priceLadder(lcsc10k, 389, 16.7)).toMatchObject({ orderQty: 400, note: 'Sold in multiples of 100' });
    expect(priceLadder(lcsc10k, 40, 16.7)).toMatchObject({ orderQty: 100, note: 'Minimum order 100' });
  });

  it('DigiKey: a reel number asked for 389 comes back as its cut tape; a reel is kept when it is cheaper', () => {
    expect(bestPackaging({ ...reel, alternatives: [cutTape] }, 389, 1)).toMatchObject({
      supplierPn: '311-10.0KHRCT-ND', orderQty: 389, packaging: 'Cut Tape (CT)', swappedFrom: '311-10.0KHRTR-ND',
    });
    const big = bestPackaging({ ...reel, alternatives: [cutTape] }, 5000, 1)!;
    expect([big.supplierPn, big.swappedFrom ?? null]).toEqual(['311-10.0KHRTR-ND', null]); // 5000 x 0.03 beats 5000 x 0.2
    expect(bestPackaging({ ...cutTape, stock: 0, alternatives: [{ ...reel, stock: 0 }] }, 10, 1)!.enoughStock).toBe(false);
  });

  it('the files use the checked part number and quantity', () => {
    const lines = [{ stockCode: 'RES-002', description: '10k 0603', footprint: '0603', supPns: ['603-RC0603FR-0710KL', '311-10.0KHRTR-ND', 'C98220'], qty: 389 }];
    const checked = (code: string, s: string) => (s === 'lcsc' ? { supplierPn: 'C98220', qty: 400 } : s === 'digikey' ? { supplierPn: '311-10.0KHRCT-ND', qty: 389 } : null);
    const [mouser, digikey, lcsc] = supplierOrders(lines, undefined, checked);
    expect(orderCsv('mouser', mouser.rows)).toBe('603-RC0603FR-0710KL|389\n'); // not checked: as it was
    expect(orderCsv('digikey', digikey.rows)).toBe('Quantity,Part Number\n389,"311-10.0KHRCT-ND"\n');
    expect(orderCsv('lcsc', lcsc.rows)).toBe('Comment,Designator,Footprint,LCSC Part #,Quantity\n"10k 0603","","0603","C98220",400\n');
  });

  it('LCSC descriptions in plain text, so the symbols read in Excel and the upload', () => {
    expect(plainText('100MW THICK FILM RESISTORS 75V ±100PPM/°C ±1% 10KΩ 0603')).toBe('100MW THICK FILM RESISTORS 75V +/-100PPM/ degC +/-1% 10Kohm 0603');
    expect(plainText('RIGHT ANGLE 90°  ×2 – café')).toBe('RIGHT ANGLE 90 deg x2 - cafe');
  });
});
