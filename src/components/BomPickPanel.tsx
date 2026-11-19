// The desktop's half of scanning a BOM out (BOM Manager > Book Out Entire
// BOM): how to start the phone, each line going green as it is scanned,
// then the final check that books it out. Server: src/lib/bomPicks.ts;
// phone: src/scan/BomPick.tsx.

import React, { useState } from 'react';
import { CheckCircle2, CircleDot, Layers, Loader2, ShieldCheck, Smartphone, X } from 'lucide-react';
import { fmtNumber } from '../lib/formatMoney';
import { useEscapeKey } from '../lib/useEscapeKey';

export interface PickView {
  id: number; projectId: number; projectName: string | null; buildQty: number; status: 'OPEN' | 'BOOKED' | 'CANCELLED';
  createdBy: string | null; picker: string | null; pickerSeenAt: string | null;
  lines: Array<{
    id: number; bomCode: string; code: string; need: number; picked: number; state: 'done' | 'part' | 'todo'; itemsForBomLine: number; reel: boolean;
    item: { name: string } | null;
    scans: Array<{ id: number; locationCode: string | null; lot: string | null; qty: number; wholeReel: boolean; by: string }>;
  }>;
  done: number; total: number; complete: boolean;
}

/** BOM lines whose every scanned item is in: green, and out of the alternate choices. */
export function scannedBomLines(pick: PickView | null): Set<string> {
  const out = new Set<string>();
  if (!pick || pick.status !== 'OPEN') return out;
  const byBom = new Map<string, PickView['lines']>();
  for (const l of pick.lines) byBom.set(l.bomCode, [...(byBom.get(l.bomCode) ?? []), l]);
  for (const [bom, ls] of byBom) if (ls.every(l => l.state === 'done')) out.add(bom);
  return out;
}

/** "seen 5 s ago" for the person scanning. */
export const seenAgo = (v: string | null, now = Date.now()) => {
  const t = new Date(v || '').getTime();
  if (isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : new Date(t).toLocaleString('en-ZA', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};

export const BomPickPanel: React.FC<{
  pick: PickView;
  onClose: () => void;
  onCancelPick: () => void;
  onBookOut: () => Promise<void>;
}> = ({ pick, onClose, onCancelPick, onBookOut }) => {
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  useEscapeKey(onClose, true);
  const pct = pick.total ? Math.round((pick.done / pick.total) * 100) : 0;
  const recent = pick.pickerSeenAt && Date.now() - new Date(pick.pickerSeenAt).getTime() < 120_000;
  const units = pick.lines.reduce((s, l) => s + l.picked, 0);
  const extra = pick.lines.filter(l => l.picked > l.need);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-surface-container border border-outline-variant rounded-xl shadow-2xl max-w-[880px] w-full mx-4 max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Scan the BOM out">
        <div className="px-lg py-md border-b border-outline-variant flex items-center gap-xs">
          <Layers className="w-4 h-4 text-primary" />
          <h4 className="font-bold text-sm text-on-surface flex-1">{checking ? 'Final check' : 'Scan to book out'}: {pick.projectName || `Project ${pick.projectId}`} × {pick.buildQty}</h4>
          <button type="button" onClick={onClose} aria-label="Close" className="text-outline hover:text-on-surface"><X className="w-4 h-4" /></button>
        </div>

        {!checking ? (
          <div className="px-lg py-md overflow-y-auto space-y-md text-xs">
            <div className="flex flex-wrap gap-lg items-center">
              <a href="/scan" target="_blank" rel="noreferrer" className="block bg-white p-2 rounded-lg leading-none shrink-0" title="Open the scanner">
                <img src="/docs/scan-qr.svg" alt="QR code for the scanner" width={120} height={120} />
              </a>
              <div className="flex-1 min-w-[240px] space-y-1.5 text-on-surface-variant">
                <p className="text-sm font-bold text-on-surface flex items-center gap-1.5"><Smartphone className="w-4 h-4 text-primary" />Pick it with the scanner</p>
                <ol className="list-decimal pl-4 space-y-0.5">
                  <li>On the phone, open <span className="font-mono text-primary">tracklab-im.fly.dev/scan</span> (scan this code) and sign in.</li>
                  <li>Tap <strong className="text-on-surface">SCAN BOM ITEMS</strong> and open this BOM.</li>
                  <li>Scan each item where the phone says it is. Lines go green here as they're picked.</li>
                </ol>
                <p className={recent ? 'text-green-400 font-bold' : 'text-outline'}>{pick.picker ? `${pick.picker} is scanning · seen ${seenAgo(pick.pickerSeenAt)}` : 'Waiting for a phone to open it…'}</p>
              </div>
            </div>

            <div>
              <div className="flex items-baseline justify-between mb-1"><span className="font-bold text-on-surface">{pick.done} of {pick.total} items picked</span><span className="font-mono text-outline">{pct}%</span></div>
              <div className="h-2 rounded-full bg-surface-container-highest overflow-hidden"><div className="h-full bg-green-500 transition-all" style={{ width: `${pct}%` }} /></div>
            </div>

            <ul className="divide-y divide-outline-variant/30 border border-outline-variant/40 rounded-lg" data-testid="bom-pick-lines">
              {pick.lines.map(l => (
                <li key={l.id} className={`px-sm py-1.5 flex items-center gap-sm ${l.state === 'done' ? 'bg-green-500/10' : l.state === 'part' ? 'bg-amber-500/5' : ''}`} data-state={l.state}>
                  {l.state === 'done' ? <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" /> : <CircleDot className={`w-4 h-4 shrink-0 ${l.state === 'part' ? 'text-amber-400' : 'text-outline'}`} />}
                  <span className="font-mono font-bold text-on-surface w-40 truncate">{l.code}</span>
                  <span className="flex-1 truncate text-on-surface-variant">{l.item?.name}{l.bomCode !== l.code ? ` · for ${l.bomCode}` : ''}{l.itemsForBomLine > 1 ? ` · 1 of ${l.itemsForBomLine} items` : ''}{l.reel ? ' · whole reels' : ''}</span>
                  <span className="font-mono text-right w-28">{fmtNumber(l.picked)} / {fmtNumber(l.need)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="px-lg py-md overflow-y-auto space-y-sm text-xs">
            <p className="text-on-surface-variant">Check what was scanned before it's booked out. Each scan comes off stock from the place it was scanned at.</p>
            <table className="w-full text-left" data-testid="bom-final-check">
              <thead><tr className="text-[10px] uppercase text-outline border-b border-outline-variant"><th className="py-1.5">Item</th><th>For BOM line</th><th className="text-right">Needed</th><th className="text-right">Scanned</th><th className="pl-md">From</th></tr></thead>
              <tbody className="divide-y divide-outline-variant/30">
                {pick.lines.map(l => (
                  <tr key={l.id}>
                    <td className="py-1.5 font-mono font-bold">{l.code}</td>
                    <td className="font-mono text-on-surface-variant">{l.bomCode}</td>
                    <td className="text-right font-mono">{fmtNumber(l.need)}</td>
                    <td className={`text-right font-mono font-bold ${l.picked > l.need ? 'text-amber-400' : 'text-green-400'}`}>{fmtNumber(l.picked)}</td>
                    <td className="pl-md text-on-surface-variant">{l.scans.map(s => `${s.wholeReel ? 'reel ' : ''}${fmtNumber(s.qty)} @ ${s.locationCode || 'no location'}${s.lot ? ` lot ${s.lot}` : ''} (${s.by})`).join('; ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="font-bold text-on-surface">{fmtNumber(units)} units of {pick.lines.length} items will be booked out.</p>
            {extra.length > 0 && <p className="text-amber-400">{extra.length} item{extra.length === 1 ? ' is' : 's are'} on reels and booked out a whole reel, more than the BOM needs: {extra.map(l => `${l.code} +${fmtNumber(l.picked - l.need)}`).join(', ')}.</p>}
          </div>
        )}

        <div className="px-lg py-md border-t border-outline-variant flex flex-wrap items-center justify-end gap-sm">
          {!checking ? (
            <>
              <button type="button" onClick={onCancelPick} className="mr-auto px-md py-1.5 rounded-lg text-xs font-bold border border-error/40 text-error hover:bg-error/10">Cancel this pick</button>
              <button type="button" onClick={onClose} className="px-md py-1.5 rounded-lg text-xs font-bold border border-outline-variant text-on-surface hover:bg-surface-variant/40">Close (keeps scanning)</button>
              <button type="button" disabled={!pick.complete} onClick={() => setChecking(true)} title={pick.complete ? '' : 'Every line must be scanned first'}
                className="px-md py-1.5 rounded-lg text-xs font-bold bg-primary text-on-primary hover:brightness-110 disabled:opacity-40 flex items-center gap-xs">
                <ShieldCheck className="w-3.5 h-3.5" />Final check{pick.complete ? '' : ` (${pick.total - pick.done} to scan)`}
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => setChecking(false)} className="mr-auto px-md py-1.5 rounded-lg text-xs font-bold border border-outline-variant text-on-surface">Back</button>
              <button type="button" disabled={busy} onClick={async () => { setBusy(true); try { await onBookOut(); } finally { setBusy(false); } }}
                className="px-md py-1.5 rounded-lg text-xs font-bold bg-green-600 text-white hover:brightness-110 disabled:opacity-40 flex items-center gap-xs">
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}Approve &amp; book out
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
