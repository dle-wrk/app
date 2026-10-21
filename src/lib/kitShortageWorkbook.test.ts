import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { buildShortageSheets, safeSheetNames, type KitRow } from './kitShortageWorkbook';

// Audit at 50 boards: CAP-001 2/board (100 needed, 40 on hand); CHP-027 1/board (50, 60 on hand); RES-9 DNF.
const rows: Array<KitRow & { pns: Record<string, string> }> = [
  { component_id: 'CAP-001', resolved_part_number: 'CAP-001', used_alternative: false, qty_required: 100, qty_on_hand: 40, description: '100nF, X7R', designator: 'C1,C2', pns: { lcsc: 'C1591', mouser: '187-CL10B104' } },
  { component_id: 'CHP-027', resolved_part_number: 'CHP-027', used_alternative: false, qty_required: 50, qty_on_hand: 60, description: 'USB hub', pns: { lcsc: 'C626667' } },
  { component_id: 'RES-9', resolved_part_number: 'RES-9', used_alternative: false, qty_required: 50, qty_on_hand: 0, description: '10k', pns: {} },
];
const input = (over = {}) => ({
  rows, buildQty: 50, quantities: [50, 100, 250, 500, 1000], suppliers: ['lcsc', 'mouser', 'digikey'] as const as any, includeDnf: false,
  isDnf: (r: KitRow) => r.component_id === 'RES-9', reservedElsewhere: () => 0,
  supplierPn: (r: any, s: string) => r.pns[s] || '', projectName: 'TCU06 PCB', date: '2026-10-21', ...over,
});

describe('one workbook for the preset export', () => {
  it('has a Summary, then per quantity a shortages sheet and one per supplier: 1 + 5 × 4 = 21 sheets', () => {
    const sheets = buildShortageSheets(input());
    expect(sheets.length).toBe(21);
    expect(sheets.slice(0, 6).map((s) => s.name)).toEqual(['Summary', 'Qty 50', 'Qty 50 LCSC', 'Qty 50 Mouser', 'Qty 50 DigiKey', 'Qty 100']);
  });

  it('works out shortages per quantity as numbers, and each supplier sheet in its upload columns', () => {
    const sheets = buildShortageSheets(input());
    const at = (name: string) => sheets.find((s) => s.name === name)!.rows;
    expect(at('Qty 50').slice(1)).toEqual([['CAP-001', '100nF, X7R', 'C1,C2', 2, 100, 40, 60, '', 0]]);
    expect(at('Qty 100').map((r) => r[0])).toEqual(['Part', 'CAP-001', 'CHP-027']); // CHP-027 short 40 from 100 boards
    expect(at('Qty 100 LCSC')).toEqual([['Comment', 'Designator', 'Footprint', 'LCSC Part #', 'Quantity'], ['100nF  X7R', '', '', 'C1591', 160], ['USB hub', '', '', 'C626667', 40]]);
    expect(at('Qty 100 Mouser')).toEqual([
      ['Mouser Part Number', 'Quantity', 'Paste line (PN|qty)'], ['187-CL10B104', 160, '187-CL10B104|160'],
      [], ['Not orderable from Mouser: no Mouser part number (1)'], ['Part', 'Needed', 'On Hand', 'Shortage'], ['CHP-027', 100, 60, 40],
    ]);
    expect(at('Qty 50 DigiKey')[1]).toEqual(['Nothing to order from DigiKey at this quantity.']);
    expect(at('Summary')[3]).toEqual(['Build qty', 'Shortage lines', 'Units short', 'LCSC lines', 'No LCSC PN', 'Mouser lines', 'No Mouser PN', 'DigiKey lines', 'No DigiKey PN']);
    expect(at('Summary')[5]).toEqual([100, 2, 200, 2, 0, 1, 1, 0, 2]);
  });

  it('includes DNF lines only when asked, and gives a quantity with nothing short its sheet anyway', () => {
    expect(buildShortageSheets(input({ includeDnf: true })).find((s) => s.name === 'Qty 50')!.rows.map((r) => r[0])).toEqual(['Part', 'CAP-001', 'RES-9']);
    const none = buildShortageSheets(input({ rows: [rows[1]], quantities: [50], suppliers: [] }));
    expect(none.map((s) => s.name)).toEqual(['Summary', 'Qty 50']);
    expect(none[1].rows[1]).toEqual(['No shortages at this build quantity.']);
  });

  it('writes as a real Excel file that reads back with every sheet', () => {
    const sheets = buildShortageSheets(input());
    const wb = XLSX.utils.book_new();
    safeSheetNames(sheets.map((s) => s.name)).forEach((n, i) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheets[i].rows), n));
    const back = XLSX.read(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }), { type: 'array' });
    expect(back.SheetNames.length).toBe(21);
    expect(back.Sheets['Qty 1000 DigiKey']).toBeTruthy();
    expect(back.Sheets['Qty 50']['G2'].v).toBe(60); // a number cell
  });

  it('keeps sheet names inside Excel rules', () => {
    expect(safeSheetNames(['Qty 50 LCSC', 'A/B:C*?', 'x'.repeat(40), 'x'.repeat(40)])).toEqual(['Qty 50 LCSC', 'A B C', 'x'.repeat(31), `${'x'.repeat(28)} 2`]);
  });
});
