import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ItemSuppliers } from './ItemDetailModal';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const rows = () => [...host.querySelectorAll('tbody tr')].map((r) => r.textContent);

describe('the Suppliers tab', () => {
  it('lists each supplier slot with its numbers and page, and names an other shop by its link', () => {
    const item: any = {
      partNumber: 'CHP-032', supplier: 'Mouser',
      manPns: ['TLV70233DBVT', 'TLV70233DBVT', 'TLV70233DBVT', 'N/A', 'N/A'],
      supPns: ['595-TLV70233DBVT', '296-27895-1-ND', 'C110287', 'N/A', ''],
      weblinks: ['https://www.mouser.co.za/ProductDetail/x', 'N/A', 'https://www.lcsc.com/product-detail/C110287.html', 'https://www.communica.co.za/products/abc', ''],
    };
    act(() => root.render(<ItemSuppliers item={item} />));
    expect(host.textContent).toContain('Sold by 4 suppliers');
    expect(host.textContent).toContain('Preferred supplier: Mouser');
    expect(rows()).toEqual([
      '1. MouserTLV70233DBVT595-TLV70233DBVT Open',
      '2. DigiKeyTLV70233DBVT296-27895-1-NDN/A',
      '3. LCSCTLV70233DBVTC110287 Open',
      '4. communica.co.zaN/AN/A Open',
    ]); // slot 5 is empty, so not shown
  });

  it('shows Mouser, DigiKey and LCSC as N/A on an item with nothing', () => {
    act(() => root.render(<ItemSuppliers item={{ partNumber: 'X' } as any} />));
    expect(host.textContent).toContain('No supplier part numbers yet');
    expect(rows()).toHaveLength(3);
  });
});
