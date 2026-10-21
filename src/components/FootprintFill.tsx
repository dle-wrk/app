// Sync Stock > Footprints: items with no footprint, filled from what their
// Size, Package, description or name already says (src/lib/footprintRules).
// Kit Booking and the BOM reel picker only offer a part as equivalent when
// footprints match, so these are the items it can't offer yet.

import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, Ruler } from 'lucide-react';
import { fmtNumber } from '../lib/formatMoney';
import { currentUserCan } from '../lib/permissions';
import { PrimaryButton } from './bookkeeping/shared';

interface Proposal { serialNumber: string; name: string; footprint: string; from: string }

export default function FootprintFill({ onShowNotification, onOpenItem, onChanged }: {
  onShowNotification: (msg: string, type?: 'SUCCESS' | 'ERROR' | 'INFO') => void;
  onOpenItem?: (serialNumber: string) => void;
  onChanged?: () => void;
}) {
  const canFix = currentUserCan('inventory.update');
  const [list, setList] = useState<Proposal[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/inventory/footprint-fill');
      const body = await res.json().catch(() => ({}));
      if (res.ok) setList(body.proposals ?? []);
    } catch { /* shown as still loading; Sync Stock again to retry */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const apply = async () => {
    if (!list?.length) return;
    setBusy(true);
    try {
      const res = await fetch('/api/inventory/footprint-fill/apply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: list.map((p) => ({ serialNumber: p.serialNumber, footprint: p.footprint })) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { onShowNotification(body.error || 'Could not fill the footprints.', 'ERROR'); return; }
      const n = body.applied?.length ?? 0; const skipped = body.skipped?.length ?? 0;
      onShowNotification(`${fmtNumber(n)} footprint${n === 1 ? '' : 's'} filled${skipped ? `; ${fmtNumber(skipped)} skipped (changed meanwhile)` : ''}.`, skipped ? 'INFO' : 'SUCCESS');
      if (n) onChanged?.();
      await load();
    } finally { setBusy(false); }
  };

  if (!list || list.length === 0) return null;
  return (
    <div className="bg-surface-container rounded-xl border border-outline-variant p-lg space-y-sm" data-testid="footprint-fill">
      <div className="flex flex-col md:flex-row md:items-start justify-between gap-md">
        <div>
          <h4 className="text-base font-bold text-on-surface flex items-center gap-2"><Ruler className="w-4 h-4 text-primary" /> Footprints</h4>
          <p className="text-xs text-on-surface-variant mt-1 max-w-[680px]">
            {fmtNumber(list.length)} {list.length === 1 ? 'item has' : 'items have'} no footprint, but {list.length === 1 ? 'its' : 'their'} description or size says it.
            Kit Booking and the Bill of Materials only offer a part as an equivalent reel when footprints match. Only one clear package is filled; anything naming two is left for you.
          </p>
        </div>
        {canFix && (
          <PrimaryButton type="button" disabled={busy} onClick={() => void apply()} icon={busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Ruler className="w-3.5 h-3.5" />}>
            Fill {fmtNumber(list.length)}
          </PrimaryButton>
        )}
      </div>
      <div className="max-h-[260px] overflow-y-auto custom-scrollbar rounded-lg border border-outline-variant">
        <table className="w-full text-left text-xs">
          <tbody className="divide-y divide-outline-variant/30">
            {list.map((p) => (
              <tr key={p.serialNumber} data-fp={p.serialNumber}>
                <td className="px-md py-1.5 whitespace-nowrap">
                  {onOpenItem
                    ? <button type="button" className="font-mono font-bold text-primary hover:underline" onClick={() => onOpenItem(p.serialNumber)}>{p.serialNumber}</button>
                    : <span className="font-mono font-bold">{p.serialNumber}</span>}
                </td>
                <td className="px-md py-1.5 text-on-surface-variant">{p.name}</td>
                <td className="px-md py-1.5 font-mono text-primary font-bold">→ {p.footprint}</td>
                <td className="px-md py-1.5 text-[10px] text-outline">from its {p.from}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
