import { describe, expect, it } from 'vitest';
import { stockValues } from './stockValue';
import { mapDbRowToItem } from './mapDbItem';
import { ITEM_STATUSES, ITEM_STATUS_SQL } from './itemStatus';

const item = (status: string, price: number, stockLevel: number, bulkPriceZar?: number) => ({ status, price, stockLevel, bulkPriceZar }) as any;

describe('stockValues', () => {
  it('values inactive and do-not-use stock on its own, and leaves discontinued and booked-out stock out', () => {
    const { counted, setAside } = stockValues([
      item('ACTIVE', 2, 10, 40),
      item('ACTIVE', 1, 5),
      item('INACTIVE', 3, 4, 60),
      item('DO NOT USE', 10, 2),
      item('DISCONTINUED', 100, 100, 1000),
      item('BOOKED OUT', 100, 100),
      item('ACTIVE', 50, -3, 10), // over-issued: no value
    ]);
    expect(counted).toEqual({ costUsd: 25, bulkZar: 400, stocked: 2, bulkPriced: 1 });
    expect(setAside).toEqual({ costUsd: 32, bulkZar: 240, stocked: 2, bulkPriced: 1 });
  });
});

describe('DO NOT USE', () => {
  it('is a status everywhere', () => {
    expect(ITEM_STATUSES).toContain('DO NOT USE');
    expect(ITEM_STATUS_SQL).toBe("('ACTIVE', 'INACTIVE', 'BOOKED OUT', 'DISCONTINUED', 'DO NOT USE')");
    expect(mapDbRowToItem({ serial_number: 'CAP-009', status: 'do not use' }).status).toBe('DO NOT USE');
    expect(mapDbRowToItem({ serial_number: 'CAP-009', status: 'SOMETHING' }).status).toBe('ACTIVE');
  });
});
