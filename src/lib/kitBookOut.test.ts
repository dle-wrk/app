import { describe, expect, it } from 'vitest';
import { planKitBookOut } from './kitBookOut';

const stock = new Map(Object.entries({ 'RES-033': { stock: 4752 }, 'RES-041': { stock: 20000 }, 'CAP-001': { stock: 500 }, 'DNF-013': { stock: 0 } }));
const line = (id: string, qty: number, shortage = 0) => ({ component_id: id, resolved_part_number: id, qty_required: qty, shortage_qty: shortage });

describe('kit book-out', () => {
  it('takes each pick from its own reel, and a line with no picks from its own part', () => {
    const plan = planKitBookOut([line('RES-033', 18000, 13248), line('CAP-001', 300)], { 'RES-033': [{ allocatedCode: 'RES-033', qty: 4752 }, { allocatedCode: 'RES-041', qty: 13248 }] }, [], stock);
    expect(plan.problems).toEqual([]);
    expect(plan.deductions).toEqual([
      { code: 'RES-033', qty: 4752, forLine: 'RES-033' }, { code: 'RES-041', qty: 13248, forLine: 'RES-033' }, { code: 'CAP-001', qty: 300, forLine: 'CAP-001' },
    ]); // the audit's shortage for RES-033 doesn't matter: its picks cover it
  });

  it('leaves DNF lines out', () => {
    expect(planKitBookOut([line('DNF-013', 1000, 1000)], {}, ['DNF-013'], stock)).toEqual({ deductions: [], skipped: ['DNF-013'], problems: [] });
  });

  it('refuses, changing nothing, when picks fall short, a reel is used up across lines, or a line without picks is short', () => {
    expect(planKitBookOut([line('RES-033', 18000)], { 'RES-033': [{ allocatedCode: 'RES-033', qty: 4752 }] }, [], stock).problems).toEqual(['RES-033: picks cover 4752 of 18000.']);
    const shared = planKitBookOut([line('A', 400), line('B', 200)], { A: [{ allocatedCode: 'CAP-001', qty: 400 }], B: [{ allocatedCode: 'CAP-001', qty: 200 }] }, [], stock);
    expect(shared.problems).toEqual(['CAP-001: needs 600, has 500.']);
    expect(planKitBookOut([line('CAP-001', 300, 50)], {}, [], stock).problems).toEqual(['CAP-001: short by 50.']); // reserved by other kits, as before
    expect(planKitBookOut([line('A', 10)], { A: [{ allocatedCode: 'NOPE-1', qty: 10 }] }, [], stock).problems).toEqual(["A: NOPE-1 isn't in Items & Inventory."]);
  });
});
