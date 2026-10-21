// Pricing > Part Numbers > Line up by supplier: checks every item with the
// suppliers and proposes its manufacturer part numbers, supplier part numbers
// and web links lined up by slot (1 Mouser, 2 DigiKey, 3 LCSC, 4-5 other),
// N/A where a supplier has nothing. Nothing changes until applied.
// Server: src/lib/partAlignRoutes.ts; the rule: src/lib/partAlign.ts.

import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, ListChecks, Play } from 'lucide-react';
import { confirmDialog } from '../lib/confirmDialog';
import { canChange } from '../lib/changeAccess';
import { fmtNumber } from '../lib/formatMoney';
import { PrimaryButton, SecondaryButton } from './bookkeeping/shared';

interface Slots { man: string[]; sup: string[]; web: string[] }
interface Proposal { serialNumber: string; name: string | null; before: Slots; after: Slots; found: Record<string, { status: string; message?: string; discovered?: boolean }> | null; notes: string[] }
const SUPPLIER_NAME: Record<string, string> = { mouser: 'Mouser', digikey: 'DigiKey', lcsc: 'LCSC' };
interface Run { running: boolean; total: number; done: number; proposals: number; startedAt: string | null; finishedAt: string | null; error: string | null }

const SLOT = ['1. Mouser', '2. DigiKey', '3. LCSC', '4. Other', '5. Other'];
const LISTS: Array<{ key: keyof Slots; label: string }> = [
  { key: 'man', label: 'Mfr PN' }, { key: 'sup', label: 'Sup PN' }, { key: 'web', label: 'Web link' },
];
const NONE = /^(|N\/?A|-)$/i;
const shown = (v: string) => (NONE.test(String(v ?? '').trim()) ? 'N/A' : v);

const Changes: React.FC<{ p: Proposal }> = ({ p }) => {
  const rows: Array<{ list: string; slot: string; from: string; to: string }> = [];
  for (const { key, label } of LISTS) {
    p.after[key].forEach((to, i) => {
      const from = p.before[key]?.[i] ?? '';
      if (shown(from) !== shown(to)) rows.push({ list: label, slot: SLOT[i], from: shown(from), to: shown(to) });
    });
  }
  return (
    <table className="text-[11px] w-full" data-testid={`align-${p.serialNumber}`}>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="align-top">
            <td className="pr-2 text-outline whitespace-nowrap">{r.list} {r.slot}</td>
            <td className="pr-2 font-mono text-outline line-through break-all max-w-[260px]">{r.from}</td>
            <td className="font-mono text-primary break-all max-w-[260px]">→ {r.to}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

export default function PartAlign({ onShowNotification, onOpenItem, onChanged }: {
  onShowNotification: (msg: string, type?: 'SUCCESS' | 'ERROR' | 'INFO') => void;
  onOpenItem?: (serialNumber: string) => void;
  onChanged?: () => void;
}) {
  const may = canChange('/api/inventory/part-align/run');
  const [run, setRun] = useState<Run | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/inventory/part-align');
      const data = await res.json().catch(() => ({}));
      if (res.ok) { setRun(data.run); setProposals(data.proposals ?? []); }
    } catch { /* try again on the next tick */ }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // While a check runs, follow its progress.
  useEffect(() => {
    if (!run?.running) return;
    const id = window.setInterval(() => { void load(); }, 3000);
    return () => window.clearInterval(id);
  }, [run?.running, load]);

  const start = async () => {
    const ok = await confirmDialog({
      title: 'Check every item with the suppliers',
      message: 'Asks LCSC, Mouser and DigiKey for each item\'s manufacturer part number and lines up the three lists by slot (1 Mouser, 2 DigiKey, 3 LCSC, 4-5 other). Where Mouser, DigiKey or LCSC is N/A, it searches them for the same part number and fills in their number and link (exact matches only). It takes about half an hour (Mouser allows 30 calls a minute) and changes nothing: you see each item\'s changes and apply them.',
      confirmLabel: 'Start the check',
    });
    if (!ok) return;
    setBusy('run');
    try {
      const res = await fetch('/api/inventory/part-align/run', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 409) onShowNotification(data.error || 'Could not start the check.', 'ERROR');
      setRun(data.run ?? null);
    } finally { setBusy(null); }
  };

  const apply = async (serials: string[], key: string) => {
    if (serials.length > 1 && !(await confirmDialog({ title: 'Apply', message: `Line up ${fmtNumber(serials.length)} items as shown? Each change is recorded in the activity log.`, confirmLabel: `Apply ${fmtNumber(serials.length)}` }))) return;
    setBusy(key);
    try {
      const res = await fetch('/api/inventory/part-align/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serials }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onShowNotification(data.error || 'Could not apply.', 'ERROR'); return; }
      onShowNotification(`${fmtNumber(data.applied.length)} lined up${data.skipped.length ? `; ${fmtNumber(data.skipped.length)} skipped (changed since the check)` : ''}.`, data.skipped.length ? 'INFO' : 'SUCCESS');
      if (data.applied.length) onChanged?.();
      await load();
    } finally { setBusy(null); }
  };

  const ready = proposals.filter((p) => !p.notes?.length || p.notes.length === 0);
  const pct = run && run.total ? Math.round((run.done / run.total) * 100) : 0;

  return (
    <div className="bg-surface-container rounded-xl border border-outline-variant p-lg space-y-md" data-testid="part-align">
      <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-md">
        <div className="max-w-[760px]">
          <h4 className="text-base font-bold text-on-surface flex items-center gap-2"><ListChecks className="w-4 h-4 text-primary" /> Line up by supplier</h4>
          <p className="text-xs text-on-surface-variant mt-1 leading-relaxed">
            Manufacturer part numbers, supplier part numbers and web links each have five slots, and slot 1 is Mouser in all three, 2 DigiKey, 3 LCSC, 4-5 other. Mfr PN 2 is the manufacturer part number as DigiKey lists it, and so on. The check asks the suppliers and shows what would change. Where an item has nothing at Mouser, DigiKey or LCSC, it searches them for the same part number and fills in their number and link (exact matches only; LCSC is found through JLCPCB's parts search and confirmed with LCSC). A slot with nothing for its supplier says N/A, and nothing is thrown away (anything that doesn't fit goes to 4-5).
          </p>
        </div>
        {may && (
          <PrimaryButton type="button" onClick={() => void start()} disabled={!!run?.running || busy !== null}
            icon={run?.running || busy === 'run' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}>
            {run?.running ? 'Checking…' : proposals.length ? 'Check again' : 'Check every item'}
          </PrimaryButton>
        )}
      </div>

      {run?.running && (
        <div className="space-y-1" data-testid="align-progress">
          <div className="h-1.5 rounded-full bg-surface-container-highest overflow-hidden"><div className="h-full bg-primary" style={{ width: `${pct}%` }} /></div>
          <p className="text-[11px] text-outline">{fmtNumber(run.done)} of {fmtNumber(run.total)} items checked; {fmtNumber(run.proposals)} would change. You can leave this page; the check carries on.</p>
        </div>
      )}
      {run?.error && <p className="text-xs text-error">The check stopped: {run.error}</p>}

      {proposals.length > 0 && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-sm">
            <p className="text-xs text-on-surface">{fmtNumber(proposals.length)} items would change{run?.finishedAt && !run.running ? ` (checked ${new Date(run.finishedAt).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })})` : ''}.</p>
            {may && ready.length > 0 && (
              <PrimaryButton type="button" disabled={busy !== null || !!run?.running} onClick={() => void apply(ready.map((p) => p.serialNumber), 'all')}
                icon={busy === 'all' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : undefined}>
                Apply all {fmtNumber(ready.length)}
              </PrimaryButton>
            )}
          </div>
          <div className="max-h-[520px] overflow-y-auto custom-scrollbar divide-y divide-outline-variant/30 rounded-lg border border-outline-variant">
            {proposals.map((p) => {
              const errors = Object.entries(p.found ?? {}).filter(([, f]) => f.status === 'error');
              const newly = Object.entries(p.found ?? {}).filter(([, f]) => f.status === 'found' && f.discovered).map(([s]) => SUPPLIER_NAME[s] ?? s);
              return (
                <div key={p.serialNumber} className="p-sm flex flex-col md:flex-row gap-sm">
                  <div className="md:w-48 shrink-0">
                    {onOpenItem
                      ? <button type="button" className="font-mono font-bold text-primary hover:underline text-xs" onClick={() => onOpenItem(p.serialNumber)}>{p.serialNumber}</button>
                      : <span className="font-mono font-bold text-xs">{p.serialNumber}</span>}
                    {p.name && <span className="block text-[11px] text-on-surface-variant">{p.name}</span>}
                    {newly.length > 0 && <span className="block text-[10px] text-green-500" data-testid="align-found">Found at {newly.join(' and ')}</span>}
                    {errors.map(([s, f]) => <span key={s} className="block text-[10px] text-amber-500">{s} couldn't be asked ({f.message}); its slot kept.</span>)}
                    {p.notes?.map((n) => <span key={n} className="block text-[10px] text-amber-500">{n}</span>)}
                  </div>
                  <div className="flex-1 min-w-0"><Changes p={p} /></div>
                  {may && (
                    <div className="shrink-0">
                      <SecondaryButton type="button" disabled={busy !== null || !!run?.running} onClick={() => void apply([p.serialNumber], p.serialNumber)}>Apply</SecondaryButton>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
      {run && !run.running && run.finishedAt && proposals.length === 0 && !run.error && (
        <p className="text-xs text-on-surface-variant">Every item is lined up.</p>
      )}
    </div>
  );
}
