// Sync Stock > Web links: web-link slots holding a page title, a part number
// or a supplier's name instead of a link, with what each becomes
// (src/lib/linkCleanup). And Check by hand: item data that disagrees with
// itself (src/lib/dataChecks), listed only.

import React, { useCallback, useEffect, useState } from 'react';
import { ClipboardCheck, Link2, Loader2 } from 'lucide-react';
import { fmtNumber } from '../lib/formatMoney';
import { currentUserCan } from '../lib/permissions';
import { PrimaryButton, SecondaryButton } from './bookkeeping/shared';

interface Fix { serialNumber: string; problem: string; why: string; changes: Array<{ field: string; from: string; to: string }>; supplier?: string }
interface Check { serialNumber: string; name: string; kind: string; detail: string }
type Toast = (msg: string, type?: 'SUCCESS' | 'ERROR' | 'INFO') => void;

const SLOT = (f: string) => `Web link ${f.replace('weblink_', '')}`;
const fixable = (f: Fix) => f.changes.length > 0 || !!f.supplier;

export function WebLinkCleanup({ onShowNotification, onOpenItem, onChanged }: { onShowNotification: Toast; onOpenItem?: (s: string) => void; onChanged?: () => void }) {
  const canFix = currentUserCan('inventory.update');
  const [fixes, setFixes] = useState<Fix[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/inventory/link-cleanup');
      const body = await res.json().catch(() => ({}));
      if (res.ok) setFixes(body.fixes ?? []);
    } catch { /* stays hidden; Sync Stock again to retry */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const apply = async (list: Fix[], key: string) => {
    setBusy(key);
    try {
      const items = list.filter(fixable).map((f) => ({ serialNumber: f.serialNumber, from: Object.fromEntries(f.changes.map((c) => [c.field, c.from])) }));
      const res = await fetch('/api/inventory/link-cleanup/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { onShowNotification(body.error || 'Could not fix the links.', 'ERROR'); return; }
      const n = body.applied?.length ?? 0; const skipped = body.skipped?.length ?? 0;
      onShowNotification(`Links fixed on ${fmtNumber(n)} item${n === 1 ? '' : 's'}${skipped ? `; ${fmtNumber(skipped)} skipped (changed meanwhile, or need a person)` : ''}.`, skipped ? 'INFO' : 'SUCCESS');
      if (n) onChanged?.();
      await load();
    } finally { setBusy(null); }
  };

  if (!fixes || fixes.length === 0) return null;
  const ready = fixes.filter(fixable);
  return (
    <div className="bg-surface-container rounded-xl border border-outline-variant p-lg space-y-sm" data-testid="link-cleanup">
      <div className="flex flex-col md:flex-row md:items-start justify-between gap-md">
        <div>
          <h4 className="text-base font-bold text-on-surface flex items-center gap-2"><Link2 className="w-4 h-4 text-primary" /> Web links that aren't links</h4>
          <p className="text-xs text-on-surface-variant mt-1 max-w-[700px]">
            {fmtNumber(fixes.length)} item{fixes.length === 1 ? ' has' : 's have'} a page title, a part number or a supplier's name in a web-link slot. A copy of a link the item already has is cleared; otherwise the supplier's page is made from the item's own part number and put in that supplier's slot (1 Mouser, 2 DigiKey, 3 LCSC). DigiKey's page is asked of DigiKey.
          </p>
        </div>
        {canFix && ready.length > 0 && (
          <PrimaryButton type="button" disabled={busy !== null} onClick={() => void apply(ready, 'all')}
            icon={busy === 'all' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />}>Fix {fmtNumber(ready.length)}</PrimaryButton>
        )}
      </div>
      <div className="max-h-[320px] overflow-y-auto custom-scrollbar divide-y divide-outline-variant/30 rounded-lg border border-outline-variant">
        {fixes.map((f) => (
          <div key={f.serialNumber} className="p-sm flex flex-col md:flex-row gap-sm" data-link-fix={f.serialNumber}>
            <div className="md:w-44 shrink-0">
              {onOpenItem ? <button type="button" className="font-mono font-bold text-primary hover:underline text-xs" onClick={() => onOpenItem(f.serialNumber)}>{f.serialNumber}</button>
                : <span className="font-mono font-bold text-xs">{f.serialNumber}</span>}
              <span className="block text-[10px] text-outline">{f.problem}</span>
            </div>
            <div className="flex-1 min-w-0 text-[11px] space-y-0.5">
              {f.changes.map((c) => (
                <div key={c.field} className="flex gap-2">
                  <span className="text-outline whitespace-nowrap">{SLOT(c.field)}</span>
                  <span className="font-mono text-outline line-through truncate max-w-[260px]" title={c.from}>{c.from}</span>
                  <span className="font-mono text-primary break-all">→ {c.to}</span>
                </div>
              ))}
              {f.supplier && <div><span className="text-outline">Supplier</span> <span className="text-primary">→ {f.supplier}</span></div>}
              <div className="text-[10px] text-on-surface-variant">{f.why}</div>
            </div>
            {canFix && fixable(f) && (
              <div className="shrink-0"><SecondaryButton type="button" disabled={busy !== null} onClick={() => void apply([f], f.serialNumber)}>Fix</SecondaryButton></div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const KIND: Record<string, string> = { value: 'Value', lcsc_link: 'LCSC link', two_numbers: 'Supplier number', wrong_slot_value: 'Supplier slot' };

export function DataChecks({ onOpenItem }: { onOpenItem?: (s: string) => void }) {
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    fetch('/api/inventory/data-checks').then((r) => r.json()).then((b) => setChecks(b.checks ?? [])).catch(() => setChecks([]));
  }, []);
  if (!checks || checks.length === 0) return null;
  const items = new Set(checks.map((c) => c.serialNumber)).size;
  return (
    <div className="bg-surface-container rounded-xl border border-outline-variant p-lg space-y-sm" data-testid="data-checks">
      <div className="flex flex-col md:flex-row md:items-start justify-between gap-md">
        <div>
          <h4 className="text-base font-bold text-on-surface flex items-center gap-2"><ClipboardCheck className="w-4 h-4 text-primary" /> Check by hand</h4>
          <p className="text-xs text-on-surface-variant mt-1 max-w-[700px]">
            {fmtNumber(checks.length)} thing{checks.length === 1 ? '' : 's'} on {fmtNumber(items)} item{items === 1 ? '' : 's'} where an item's data disagrees with itself: a value in its name, description or Yageo part number; an LCSC number and link for different parts; two nearly identical supplier numbers; or something other than a supplier's number in its slot. Nothing is changed here: open the item to correct it.
          </p>
        </div>
        <SecondaryButton type="button" onClick={() => setOpen((v) => !v)}>{open ? 'Hide' : 'Show'} the list</SecondaryButton>
      </div>
      {open && (
        <div className="max-h-[360px] overflow-y-auto custom-scrollbar rounded-lg border border-outline-variant">
          <table className="w-full text-left text-xs">
            <tbody className="divide-y divide-outline-variant/30">
              {checks.map((c, i) => (
                <tr key={i} data-check={c.serialNumber}>
                  <td className="px-md py-1.5 whitespace-nowrap align-top">
                    {onOpenItem ? <button type="button" className="font-mono font-bold text-primary hover:underline" onClick={() => onOpenItem(c.serialNumber)}>{c.serialNumber}</button>
                      : <span className="font-mono font-bold">{c.serialNumber}</span>}
                  </td>
                  <td className="px-md py-1.5 whitespace-nowrap align-top text-[10px] text-outline uppercase">{KIND[c.kind] ?? c.kind}</td>
                  <td className="px-md py-1.5 text-on-surface-variant">{c.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
