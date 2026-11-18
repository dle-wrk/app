import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VendorsTab } from './bookkeeping/VendorsTab';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement; let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); localStorage.clear(); });

const props: any = { suppliers: [{ id: '1', name: 'ACDC Express' }], bills: [], purchaseOrders: [], paymentsMade: [], expenses: [] };
const newVendor = () => [...host.querySelectorAll('button')].find(b => b.textContent?.includes('New vendor'));

describe('Purchases > Vendors', () => {
  it('has a New vendor button that opens the supplier form', async () => {
    localStorage.setItem('currentUser', JSON.stringify({ role: 'admin' }));
    const open = vi.fn();
    await act(async () => { root.render(<VendorsTab {...props} onNewVendor={open} />); });
    await act(async () => { newVendor()!.click(); });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('shows no button to someone who may not add suppliers', async () => {
    localStorage.setItem('currentUser', JSON.stringify({ role: 'viewer' }));
    await act(async () => { root.render(<VendorsTab {...props} onNewVendor={() => {}} />); });
    expect(newVendor()).toBeUndefined();
    expect(host.textContent).toContain('ACDC Express');
  });
});
