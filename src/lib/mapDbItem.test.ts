import { describe, expect, it } from 'vitest';
import { mapDbRowToItem, mapItemToPayload } from './mapDbItem';
import { itemToCsvRow } from '../mockData';

// Loading an item and saving it again must write every part number and link
// back to the slot it came from.

const ROW = {
  serial_number: 'CAP-009', name: '100nF', man_pn_1: '', man_pn_2: 'CL10B104KB8NNNC', man_pn_3: null,
  sup_pn_1: '', sup_pn_2: '  ', sup_pn_3: 'C1591', sup_pn_4: '187-CL10B104KB8NNNC', sup_pn_5: null,
  weblink_1: null, weblink_2: 'https://www.lcsc.com/product-detail/C1591.html',
};
const slotsOf = (p: Record<string, any>, prefix: string) => [1, 2, 3, 4, 5].map((n) => p[`${prefix}${n}`]);

describe('part-number slots', () => {
  it('stay in place through a load and a save', () => {
    const payload = mapItemToPayload(mapDbRowToItem(ROW));
    expect(slotsOf(payload, 'man_pn_')).toEqual(['', 'CL10B104KB8NNNC', '', '', '']);
    expect(slotsOf(payload, 'sup_pn_')).toEqual(['', '', 'C1591', '187-CL10B104KB8NNNC', '']);
    expect(slotsOf(payload, 'weblink_')).toEqual(['', 'https://www.lcsc.com/product-detail/C1591.html', '', '', '']);
  });

  it('still give the first manufacturer part number as the manufacturer', () => {
    const item = mapDbRowToItem(ROW);
    expect(item.manufacturer).toBe('CL10B104KB8NNNC');
    expect(item.manPns).toEqual(['', 'CL10B104KB8NNNC', '', '', '']);
  });

  it('leave the lists out when every slot is empty, and keep the manufacturer field then', () => {
    const item = mapDbRowToItem({ serial_number: 'TUL-001', name: 'Tweezers', manufacturer: 'Wiha' });
    expect([item.manPns, item.supPns, item.weblinks]).toEqual([undefined, undefined, undefined]);
    expect(mapItemToPayload(item)).toMatchObject({ man_pn_1: 'Wiha', sup_pn_1: '', weblink_1: '' });
  });

  it('stay in place in the CSV export', () => {
    const cols = itemToCsvRow(mapDbRowToItem(ROW)).split(';');
    const header = 'man_pn_1;man_pn_2;man_pn_3;man_pn_4;man_pn_5;sup_pn_1;sup_pn_2;sup_pn_3';
    const at = (name: string) => cols[22 + header.split(';').indexOf(name)];
    expect([at('man_pn_2'), at('sup_pn_1'), at('sup_pn_3')]).toEqual(['CL10B104KB8NNNC', '', 'C1591']);
  });
});
