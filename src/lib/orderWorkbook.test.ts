import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { buildOrderSheets } from './orderWorkbook';
import { supplierOrders } from './supplierBom';
import { workbookBytes } from './xlsxDownload';

const lines = [
  { stockCode: 'RES-002', description: '10k 0603 ±1%', footprint: '0603', supPns: ['603-RC0603FR-0710KL', '311-10.0KHRTR-ND', 'C98220'], qty: 389 },
  { stockCode: 'CON-031', description: 'Terminal block', footprint: '3x7.62mm', supPns: ['651-1728866', '', 'C441247'], qty: 50 },
  { stockCode: 'MEC-001', description: 'Bracket', footprint: '', supPns: ['N/A', 'N/A', 'N/A'], qty: 2 },
];
const priced = (supplierPn: string, orderQty: number, unitZar: number) => ({ supplierPn, orderQty, unit: unitZar, currency: 'ZAR', unitZar, totalZar: Math.round(orderQty * unitZar * 100) / 100, stock: 1000, enoughStock: true, note: null });

describe('order files as one workbook', () => {
  it('unchecked: Summary, Mouser, DigiKey, LCSC, All lines, Not listed', () => {
    const sheets = buildOrderSheets({ title: 'TCU06 PCB: shortages for 50 pcs', date: '2026-10-21', lines, orders: supplierOrders(lines) });
    expect(sheets.map((s) => s.name)).toEqual(['Summary', 'Mouser', 'DigiKey', 'LCSC', 'All lines', 'Not listed']);
    expect(sheets[0].rows[2][0]).toContain('not checked');
    expect(sheets[1].rows[1]).toEqual(['603-RC0603FR-0710KL', 389, 'RES-002', '10k 0603 ±1%']);
    expect(sheets[3].rows[1]).toEqual(['10k 0603 +/-1%', '', '0603', 'C98220', 389, 'RES-002', '10k 0603 ±1%']);
    expect(sheets[5].rows[1]).toEqual(['MEC-001', 'Bracket', '', 2]);
  });

  it('checked and split: supplier quantities and part numbers, prices, totals, where each line goes', () => {
    const quotes = new Map<string, any>([
      ['RES-002', { mouser: priced('603-RC0603FR-0710KL', 389, 0.3), digikey: { ...priced('311-10.0KHRCT-ND', 389, 0.2), swappedFrom: '311-10.0KHRTR-ND' }, lcsc: priced('C98220', 400, 0.01) }],
      ['CON-031', { mouser: priced('651-1728866', 50, 12), lcsc: priced('C441247', 50, 9) }],
    ]);
    const assignment = { 'RES-002': 'lcsc', 'CON-031': 'lcsc' } as any;
    const checked = (code: string, s: string) => { const p = quotes.get(code)?.[s]; return p ? { supplierPn: p.supplierPn, qty: p.orderQty } : null; };
    const orders = supplierOrders(lines, assignment, checked);
    const sheets = buildOrderSheets({ title: 'x', date: 'd', lines, orders, quotes, assignment });
    const lcsc = sheets.find((s) => s.name === 'LCSC')!.rows;
    expect(lcsc[1]).toEqual(['10k 0603 +/-1%', '', '0603', 'C98220', 400, 'RES-002', '10k 0603 ±1%', 0.01, 4]);
    expect(lcsc.at(-1)!.at(-1)).toBe(454); // 4 + 450
    const all = sheets.find((s) => s.name === 'All lines')!.rows;
    expect(all[0].at(-1)).toBe('Order from');
    expect(all[1]).toEqual(['RES-002', '10k 0603 ±1%', '0603', 389, '603-RC0603FR-0710KL', 389, 116.7, '311-10.0KHRCT-ND', 389, 77.8, 'C98220', 400, 4, 'LCSC']);
    expect(sheets.find((s) => s.name === 'Mouser')!.rows[1]).toEqual(['No line is cheapest at Mouser.']);
  });

  it('writes a real Excel file', async () => {
    const sheets = buildOrderSheets({ title: 'x', date: 'd', lines, orders: supplierOrders(lines) });
    const back = XLSX.read(await workbookBytes(sheets), { type: 'array' });
    expect(back.SheetNames).toEqual(['Summary', 'Mouser', 'DigiKey', 'LCSC', 'All lines', 'Not listed']);
    expect(back.Sheets.Mouser.B2.v).toBe(389);
  });
});
