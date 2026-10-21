// Sync Stock > part numbers: after the stock reloads, every item's part-number
// fields are checked (src/lib/partNumberReview.ts) and this panel fixes them
// all in one go: supplier names to the Supplier field, supplier numbers out of
// the Mfr PN fields, each supplier number to its slot (1 Mouser, 2 DigiKey,
// 3 LCSC, 4-5 other), placeholders cleared. Some fixes are only offered once
// an item's others are done, so it applies in rounds until nothing is left.
// Below it, the supplier check (./PartAlign) for what only the suppliers know.

import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Loader2, Wand2, X } from 'lucide-react';
import { fmtNumber } from '../lib/formatMoney';
import { currentUserCan, notAllowedMessage } from '../lib/permissions';
import { PrimaryButton, SecondaryButton } from './bookkeeping/shared';
import PartAlign from './PartAlign';
import FootprintFill from './FootprintFill';
import PartNumberReview, { ISSUE_TITLES, appliable, fixRequest, type PartNumberIssue } from './PartNumberReview';

type ToastType = 'SUCCESS' | 'ERROR' | 'INFO';
const ROUNDS = 5;

async function loadIssues(): Promise<PartNumberIssue[]> {
  const res = await fetch('/api/inventory/part-number-review');
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Could not check the part numbers.');
  return body.issues ?? [];
}

/** Applies every fix on offer, round after round, until none is left or a round changes nothing. */
export async function fixEverything(issues: PartNumberIssue[], post = (body: unknown) => fetch('/api/inventory/part-number-review/fix', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}), reload = loadIssues): Promise<{ applied: number; items: number; skipped: number; left: PartNumberIssue[] }> {
  let applied = 0; let skipped = 0; const items = new Set<string>();
  let now = issues;
  for (let round = 0; round < ROUNDS; round++) {
    const todo = appliable(now);
    if (!todo.length) break;
    const res = await post(fixRequest(todo));
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Could not apply the fixes.');
    const done: Array<{ serialNumber: string }> = body.applied ?? [];
    applied += done.length; skipped += body.skipped?.length ?? 0;
    done.forEach((a) => items.add(a.serialNumber));
    now = await reload();
    if (!done.length) break;
  }
  return { applied, items: items.size, skipped, left: now };
}

export default function PartNumberFillIn({ onClose, onShowNotification, onOpenItem, onChanged }: {
  onClose: () => void;
  onShowNotification: (msg: string, type?: ToastType) => void;
  onOpenItem?: (serialNumber: string) => void;
  onChanged?: () => void;
}) {
  const canFix = currentUserCan('inventory.update');
  const [issues, setIssues] = useState<PartNumberIssue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    try { setIssues(await loadIssues()); setError(null); } catch (e: any) { setError(e?.message || String(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const fixable = appliable(issues ?? []);
  const fixItems = new Set(fixable.map((i) => i.serialNumber)).size;
  const kinds = Object.entries(fixable.reduce<Record<string, number>>((m, i) => ({ ...m, [i.kind]: (m[i.kind] ?? 0) + 1 }), {}));
  const needPerson = (issues ?? []).filter((i) => !i.fix && i.kind !== 'no_part_number').length;

  const fixAll = async () => {
    setBusy(true);
    try {
      const r = await fixEverything(issues ?? []);
      setIssues(r.left);
      const msg = `${fmtNumber(r.applied)} part-number ${r.applied === 1 ? 'fix' : 'fixes'} saved on ${fmtNumber(r.items)} ${r.items === 1 ? 'item' : 'items'}${r.skipped ? `; ${fmtNumber(r.skipped)} skipped (changed meanwhile)` : ''}.`;
      setResult(msg);
      onShowNotification(msg, r.skipped ? 'INFO' : 'SUCCESS');
      if (r.applied) onChanged?.();
    } catch (e: any) {
      onShowNotification(e?.message || String(e), 'ERROR');
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center z-100 p-md" role="dialog" aria-modal="true" aria-label="Part numbers">
      <div className="bg-surface-container-low border border-outline-variant rounded-xl shadow-2xl w-full max-w-5xl max-h-[92vh] flex flex-col" data-testid="part-number-fill-in">
        <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between gap-md">
          <h3 className="font-bold text-on-surface flex items-center gap-2"><Wand2 className="w-4 h-4 text-primary" /> Stock synced: part numbers</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1 rounded text-outline hover:text-on-surface hover:bg-surface-container-high"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-lg space-y-md overflow-y-auto custom-scrollbar">
          <div className="bg-surface-container rounded-xl border border-outline-variant p-lg space-y-sm">
            {error && <p className="text-xs text-error">{error}</p>}
            {!issues && !error && <p className="text-xs text-outline flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking every item's part numbers…</p>}
            {issues && fixable.length === 0 && (
              <p className="text-sm text-on-surface flex items-center gap-2" data-testid="fill-in-clean"><CheckCircle2 className="w-4 h-4 text-green-500" /> {result ?? 'Every Mfr PN and supplier part number is in its right field.'}</p>
            )}
            {issues && fixable.length > 0 && (
              <div className="flex flex-col md:flex-row md:items-start justify-between gap-md">
                <div>
                  <p className="text-sm font-bold text-on-surface" data-testid="fill-in-summary">{fmtNumber(fixable.length)} part-number {fixable.length === 1 ? 'fix' : 'fixes'} on {fmtNumber(fixItems)} {fixItems === 1 ? 'item' : 'items'}</p>
                  <ul className="text-xs text-on-surface-variant mt-1 space-y-0.5">
                    {kinds.map(([k, n]) => <li key={k}>{ISSUE_TITLES[k] ?? k}: {fmtNumber(n)}</li>)}
                  </ul>
                  <p className="text-[11px] text-outline mt-2">Slots: 1 Mouser, 2 DigiKey, 3 LCSC, 4-5 other. Nothing is thrown away, and every change is in the activity log.</p>
                  {result && <p className="text-[11px] text-on-surface mt-1">{result}</p>}
                </div>
                {canFix
                  ? <PrimaryButton type="button" disabled={busy} onClick={() => void fixAll()} icon={busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}>Fix all {fmtNumber(fixable.length)} now</PrimaryButton>
                  : <p className="text-[11px] text-outline">{notAllowedMessage('inventory.update')}</p>}
              </div>
            )}
            {issues && (
              <div className="flex flex-wrap items-center gap-sm pt-1">
                {needPerson > 0 && <span className="text-[11px] text-amber-500">{fmtNumber(needPerson)} {needPerson === 1 ? 'needs' : 'need'} a person.</span>}
                <SecondaryButton type="button" onClick={() => setShowAll((v) => !v)}>{showAll ? 'Hide the list' : 'See every issue'}</SecondaryButton>
              </div>
            )}
          </div>
          <FootprintFill onShowNotification={onShowNotification} onOpenItem={onOpenItem} onChanged={onChanged} />
          {showAll && <PartNumberReview onShowNotification={onShowNotification} onOpenItem={onOpenItem} onChanged={() => { onChanged?.(); void load(); }} />}
          <PartAlign onShowNotification={onShowNotification} onOpenItem={onOpenItem} onChanged={onChanged} />
        </div>
      </div>
    </div>
  );
}
