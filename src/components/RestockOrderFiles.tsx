// Restock order files: everything the reorder recommendations say to order
// (Advanced Automation > Reorder: demand-based, else topping up to the
// low-stock level; items Inactive, Do Not Use or Discontinued left out),
// as one upload file per supplier. Server: GET /api/analytics/reorder-recommendations.

import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import SupplierOrderFiles, { type OrderFileLine } from './SupplierOrderFiles';
import { fmtNumber } from '../lib/formatMoney';

interface Line { stockCode: string; description: string; footprint: string; supPns: string[]; qty: number; urgency: string }

export default function RestockOrderFiles({ onShowNotification }: {
  onShowNotification: (msg: string, type?: 'SUCCESS' | 'ERROR' | 'INFO') => void;
}) {
  const [lines, setLines] = useState<Line[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/analytics/reorder-recommendations')
      .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`); return d; })
      .then((d) => { if (!cancelled) setLines(Array.isArray(d.orderLines) ? d.orderLines : []); })
      .catch((e) => { if (!cancelled) setFailed(e.message); });
    return () => { cancelled = true; };
  }, []);

  if (failed) return <p className="text-xs text-error">Couldn't work out what to reorder: {failed}</p>;
  if (!lines) return <p className="text-xs text-outline flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Working out what to reorder…</p>;

  const urgent = lines.filter((l) => l.urgency === 'CRITICAL' || l.urgency === 'HIGH').length;
  const asOrderLines: OrderFileLine[] = lines.map((l) => ({ ...l, required: l.qty, shortage: l.qty }));
  return (
    <SupplierOrderFiles
      lines={asOrderLines}
      projectName="restock"
      pcbQty={1}
      onShowNotification={onShowNotification}
      restock={{
        title: 'Restock order files',
        intro: `${fmtNumber(lines.length)} items need reordering${urgent ? ` (${fmtNumber(urgent)} urgent)` : ''}, at the suggested reorder quantities: enough for lead time and safety stock where there's usage history, else back up to the low-stock level. One file per supplier, ready to upload. Inactive and Do Not Use items are left out.`,
      }}
    />
  );
}
