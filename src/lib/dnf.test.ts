import { describe, expect, it } from 'vitest';
import { isDnfCode } from './dnf';
import { planKitBookOut } from './kitBookOut';

describe('DNF lines', () => {
  it('knows a do-not-fit stock code however it is written', () => {
    for (const c of ['DNF', 'DNF-013', 'dnf-009', 'DNF_2', 'DNF1', 'DNP', 'DNP-004', 'DO NOT FIT', 'Do Not Populate', ' DNF-013 ']) expect(isDnfCode(c), c).toBe(true);
    for (const c of ['DNFX-1', 'CAP-019', 'NCU-SYS-001', 'RES-033', 'ADNF-1', '', null]) expect(isDnfCode(c), String(c)).toBe(false);
  });

  it('book-out skips a DNF line even when it was not sent as DNF, and it never blocks the book-out', () => {
    const plan = planKitBookOut(
      [{ component_id: 'DNF-013', resolved_part_number: 'DNF-013', qty_required: 500, shortage_qty: 500 }, { component_id: 'RES-024', resolved_part_number: 'RES-024', qty_required: 500, shortage_qty: 0 }],
      {}, [], new Map([['RES-024', { stock: 4020 }], ['DNF-013', { stock: 0 }]]),
    );
    expect(plan).toEqual({ deductions: [{ code: 'RES-024', qty: 500, forLine: 'RES-024' }], skipped: ['DNF-013'], problems: [] });
  });
});
