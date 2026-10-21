import { describe, expect, it } from 'vitest';
import { leadTimeForSupplierName, measureLeadTimes, plannedLeadTime, slowestSlotLeadTime } from './supplierLeadTime';

describe('supplier lead times measured from received orders', () => {
  const measured = measureLeadTimes([
    { supplierId: '1', orderDate: '2026-08-01', receivedDate: '2026-08-21' },
    { supplierId: '1', orderDate: '2026-09-01', receivedDate: '2026-09-11' },
    { supplierId: '1', orderDate: '2026-09-10', receivedDate: '2026-10-10' },
    { supplierId: '6', orderDate: '2026-09-22', receivedDate: '2026-09-23' },
    { supplierId: '7', orderDate: '2026-09-22', receivedDate: null }, // not received: not counted
  ]);

  it('is the median days from order to receipt, with how many orders and the slowest', () => {
    expect(measured.get('1')).toEqual({ days: 20, orders: 3, slowest: 30 });
    expect(measured.get('6')).toEqual({ days: 1, orders: 1, slowest: 1 });
    expect(measured.has('7')).toBe(false);
  });

  it('plans with the measured figure, else the typed one, else nothing', () => {
    expect(plannedLeadTime({ id: '1', name: 'MOUSER', lead_time: 30 }, measured)).toEqual({ days: 20, source: 'measured' });
    expect(plannedLeadTime({ id: '2', name: 'DIGIKEY', lead_time: 21 }, measured)).toEqual({ days: 21, source: 'typed' });
    expect(plannedLeadTime({ id: '9', name: 'X', lead_time: null }, measured)).toBeNull();
    expect(plannedLeadTime({ id: '9', name: 'X', lead_time: 0 }, measured)).toBeNull(); // 0 means not filled in
  });

  it("finds an item's supplier by its Supplier field however it is written", () => {
    const suppliers = [{ id: '2', name: 'DIGIKEY', lead_time: 21 }, { id: '3', name: 'LCSC ELECTRONICS', lead_time: 21 }, { id: '6', name: 'COMMUNICA', lead_time: 0 }];
    expect(leadTimeForSupplierName('Digikey', suppliers, measured)).toEqual({ supplier: 'DIGIKEY', days: 21, source: 'typed' });
    expect(leadTimeForSupplierName('LCSC', suppliers, measured)).toEqual({ supplier: 'LCSC ELECTRONICS', days: 21, source: 'typed' });
    expect(leadTimeForSupplierName('Communica', suppliers, measured)).toEqual({ supplier: 'COMMUNICA', days: 1, source: 'measured' });
    expect(leadTimeForSupplierName('N/A', suppliers, measured)).toBeNull();
  });

  it('an item with no Supplier field plans with the slowest of the suppliers it has part numbers for', () => {
    const suppliers = [{ id: '1', name: 'MOUSER', lead_time: 30 }, { id: '2', name: 'DIGIKEY', lead_time: 21 }, { id: '3', name: 'LCSC ELECTRONICS', lead_time: 21 }];
    expect(slowestSlotLeadTime(['N/A', '296-1-ND', 'C1591'], suppliers, new Map())).toEqual({ supplier: 'DIGIKEY', days: 21, source: 'typed' });
    expect(slowestSlotLeadTime(['595-X', '296-1-ND', ''], suppliers, measured)).toEqual({ supplier: 'DIGIKEY', days: 21, source: 'typed' }); // Mouser measured 20 < 21
    expect(slowestSlotLeadTime(['N/A', 'N/A', 'N/A'], suppliers, measured)).toBeNull();
  });
});
