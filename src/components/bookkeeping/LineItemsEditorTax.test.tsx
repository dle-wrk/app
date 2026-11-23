import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { LineItemsEditor, newEditableLine, type EditableLine } from './LineItemsEditor';
import { withRoundOff } from './BillsTab';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const taxRates = [{ id: 1, name: 'Standard VAT (15%)', rate: 15, isDefault: true }, { id: 2, name: 'Zero-Rated (0%)', rate: 0 }] as any;

it('fills the default VAT rate on a new line, but never on a round-off or a line set to "No tax"', async () => {
  const lines = withRoundOff([{ ...newEditableLine(), description: 'Part', unitPrice: 100, taxRateId: 1 }], 114.95, taxRates);
  const manual: EditableLine = { ...newEditableLine(), description: 'Freight', unitPrice: 10, noTax: true };
  const fresh = newEditableLine();
  let changed: EditableLine[] | null = null;
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => {
    root.render(<LineItemsEditor lines={[...lines, manual, fresh]} onChange={(l) => { changed = l; }} items={[]} taxRates={taxRates} mode="PURCHASE" currency="ZAR" />);
  });
  expect(lines[1]).toMatchObject({ description: 'Round off (to the invoice total)', unitPrice: -0.05, taxRateId: null, noTax: true });
  const out = changed as unknown as EditableLine[];
  expect(out.map(l => l.taxRateId)).toEqual([1, null, null, 1]);
  act(() => root.unmount());
});
