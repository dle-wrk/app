import { describe, expect, it } from 'vitest';
import { pickSupplier, planAutoPos } from './autoPo';

const SUPPLIERS = [
  { id: '1', name: 'MOUSER', lead_time: 30 }, { id: '2', name: 'DIGIKEY', lead_time: 21 },
  { id: '3', name: 'LCSC ELECTRONICS', lead_time: 21 }, { id: '6', name: 'COMMUNICA', lead_time: null }, { id: '7', name: 'MICROROBOTICS', lead_time: 4 },
];
const cfg = (component_id: string, threshold: number, min: number, extra: Record<string, unknown> = {}) => ({ component_id, auto_po_threshold: threshold, min_stock_level: min, enabled: true, ...extra });
const item = (serial_number: string, stock: number, extra: Record<string, unknown> = {}) => ({ serial_number, name: serial_number, stock, current_cost_dollar: 0.05, ...extra });

describe('Auto-PO', () => {
  it('drafts what is at or below its reorder point, back up to its minimum, one purchase order per supplier', () => {
    const { groups, skipped } = planAutoPos(
      [cfg('CAP-024', 500, 2000), cfg('RES-033', 100, 1000), cfg('LED-005', 50, 200), cfg('CAP-006', 100, 400)],
      [item('CAP-024', 500, { supplier: 'Digikey' }), item('RES-033', 40, { supplier: 'DIGIKEY' }), item('LED-005', 51), item('CAP-006', 0, { sup_pn_3: 'C1591' })],
      new Set(), SUPPLIERS, new Map(),
    );
    expect(groups.map((g) => [g.supplierName, g.status, g.lines.map((l) => [l.partNumber, l.quantity])])).toEqual([
      ['DIGIKEY', 'DRAFT', [['CAP-024', 1500], ['RES-033', 960]]], // at the reorder point counts
      ['LCSC ELECTRONICS', 'DRAFT', [['CAP-006', 400]]],
    ]); // LED-005 at 51 is above its reorder point of 50
    expect(skipped).toEqual([]);
  });

  it('skips an item with a purchase order already open, a paused one, and one no longer in inventory', () => {
    const { groups, skipped } = planAutoPos(
      [cfg('CAP-024', 500, 2000), cfg('RES-033', 100, 1000, { enabled: false }), cfg('GONE-1', 10, 20)],
      [item('CAP-024', 0), item('RES-033', 0)], new Set(['CAP-024']), SUPPLIERS, new Map(),
    );
    expect(groups).toEqual([]);
    expect(skipped).toEqual([{ partNumber: 'CAP-024', reason: 'A purchase order is already open for it.' }, { partNumber: 'GONE-1', reason: 'Not in inventory (deleted?).' }]);
  });

  it('auto-approve marks its purchase order Sent, kept apart from the drafts', () => {
    const { groups } = planAutoPos([cfg('A', 5, 10, { auto_approve: true }), cfg('B', 5, 10)], [item('A', 0, { supplier: 'Mouser' }), item('B', 0, { supplier: 'Mouser' })], new Set(), SUPPLIERS, new Map());
    expect(groups.map((g) => [g.supplierName, g.status, g.lines.length])).toEqual([['MOUSER', 'SENT', 1], ['MOUSER', 'DRAFT', 1]]);
  });

  it('chooses the supplier: its Auto-PO setting, else its Supplier field, else its fastest supplier', () => {
    expect(pickSupplier(cfg('X', 1, 2, { preferred_supplier: '7' }), item('X', 0, { supplier: 'Digikey' }), SUPPLIERS, new Map())).toMatchObject({ name: 'MICROROBOTICS', reason: 'chosen on its Auto-PO setting' });
    expect(pickSupplier(cfg('X', 1, 2, { preferred_supplier: 'digikey' }), item('X', 0), SUPPLIERS, new Map())).toMatchObject({ name: 'DIGIKEY' }); // old settings saved a name
    expect(pickSupplier(cfg('X', 1, 2), item('X', 0, { supplier: 'communica' }), SUPPLIERS, new Map())).toMatchObject({ name: 'COMMUNICA', reason: 'its Supplier field' }); // no lead time typed: still found
    expect(pickSupplier(cfg('X', 1, 2), item('X', 0, { sup_pn_1: '595-X', sup_pn_2: '296-X-ND' }), SUPPLIERS, new Map())).toMatchObject({ name: 'DIGIKEY', reason: 'fastest of its suppliers (21 days)' });
    expect(pickSupplier(cfg('X', 1, 2), item('X', 0, { supplier: 'N/A' }), SUPPLIERS, new Map())).toEqual({ id: null, name: null, reason: 'no supplier known: choose one on the PO' });
  });
});
