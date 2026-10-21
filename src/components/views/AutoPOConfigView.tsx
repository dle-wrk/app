// Automation > Auto-PO Config: the items watched for reordering, and Check now.
// The panel (../AutoPoPanel) is shared with the Automation dashboard's Auto-PO tab.

import React from 'react';
import type { Item, Supplier } from '../../types';
import AutoPoPanel from '../AutoPoPanel';

interface Props {
  triggerToast: (msg: string, type?: string) => void;
  items?: Item[];
  suppliers?: Supplier[];
}

export default function AutoPOConfigView({ triggerToast, items, suppliers }: Props) {
  return (
    <div className="p-container-margin space-y-lg max-w-[1400px] mx-auto w-full">
      <div className="bg-surface-container border border-outline-variant p-lg rounded-xl space-y-md">
        <div>
          <h3 className="text-lg font-bold text-on-surface">Auto-PO</h3>
          <p className="text-sm text-on-surface-variant">Reorder points for the items you want reordered, and purchase orders drafted when they are reached.</p>
        </div>
        <AutoPoPanel triggerToast={triggerToast} items={items} suppliers={suppliers} />
      </div>
    </div>
  );
}
