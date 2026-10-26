// Locations & counts > Lot tracing: search a lot or date code (or a stock
// code) to see where it is now and which builds and invoices used it; or a
// build / invoice reference to see which lots went into it. Server: GET
// /api/lots (src/lib/stockPlaces.ts). Uses are tied to the stock movement that
// caused them, so they show from when places were first kept.

import React, { useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { fmtNumber } from '../lib/formatMoney';
import { PrimaryButton } from './bookkeeping/shared';

const when = (d: string | null) => (d ? new Date(d).toLocaleString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const input = 'bg-surface-container border border-outline-variant rounded px-3 py-2 text-sm text-on-surface';

export default function LotTrace({ triggerToast, onOpenItem }: { triggerToast: (m: string, t?: string) => void; onOpenItem?: (s: string) => void }) {
  const [mode, setMode] = useState<'lot' | 'ref'>('lot');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any | null>(null);
  const item = (s: string) => (onOpenItem ? <button type="button" className="font-mono text-primary hover:underline" onClick={() => onOpenItem(s)}>{s}</button> : <span className="font-mono">{s}</span>);

  const search = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/lots?${mode === 'lot' ? 'q' : 'ref'}=${encodeURIComponent(q.trim())}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setResult({ mode, ...body });
    } catch (e: any) { triggerToast(e.message, 'ERROR'); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-md" data-testid="lot-trace">
      <p className="text-xs text-on-surface-variant max-w-[760px]">
        Give stock a lot or date code when you put it away (an item's <strong>Places</strong> tab). Search a lot to see where it is and which builds and invoices used it, or search a build or invoice to see which lots went into it.
      </p>
      <div className="flex flex-wrap items-end gap-sm">
        <select className={input} value={mode} onChange={(e) => { setMode(e.target.value as 'lot' | 'ref'); setResult(null); }} aria-label="Search by">
          <option value="lot">Lot, date code or stock code</option><option value="ref">Build or invoice</option>
        </select>
        <input className={`${input} w-72`} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void search(); }}
          placeholder={mode === 'lot' ? 'e.g. L2410-03, 2441, CAP-024' : 'e.g. TCU06, INV-2026-0009'} aria-label="Search" />
        <PrimaryButton type="button" onClick={() => void search()} disabled={busy || q.trim().length < 2} icon={busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}>Trace</PrimaryButton>
      </div>
      {result?.mode === 'lot' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-md">
          <div><p className="text-xs font-bold text-on-surface mb-1">Where it is now</p>
            {result.now.length === 0 ? <p className="text-[11px] text-outline">None in stock.</p> : (
              <table className="w-full text-[11px]"><tbody>{result.now.map((b: any, i: number) => (
                <tr key={i}><td className="pr-2">{b.lot ?? <span className="text-outline">no lot</span>}{b.date_code ? ` · DC ${b.date_code}` : ''}</td><td className="pr-2">{item(b.serial_number)}</td>
                  <td className="pr-2">{b.location_code ?? <span className="text-outline">no location</span>}</td><td className="pr-2 font-mono">{fmtNumber(b.qty)}</td><td className="text-outline">received {when(b.received_at)}</td></tr>
              ))}</tbody></table>
            )}</div>
          <div><p className="text-xs font-bold text-on-surface mb-1">Where it was used</p>
            {result.used.length === 0 ? <p className="text-[11px] text-outline">Not used yet.</p> : (
              <table className="w-full text-[11px]"><tbody>{result.used.map((u: any, i: number) => (
                <tr key={i}><td className="pr-2">{u.lot}</td><td className="pr-2">{item(u.serial_number)}</td><td className="pr-2 font-mono">{fmtNumber(u.qty)}</td>
                  <td className="pr-2">{u.reference ?? <span className="text-outline">stock edit</span>}</td><td className="text-outline">{when(u.at)}</td></tr>
              ))}</tbody></table>
            )}</div>
        </div>
      )}
      {result?.mode === 'ref' && (
        result.used.length === 0 ? <p className="text-[11px] text-outline">No lots recorded for that. Lots are recorded once stock is in places with a lot.</p> : (
          <table className="w-full text-[11px]"><thead><tr className="text-[10px] text-outline uppercase"><th className="text-left pr-2">Movement</th><th className="text-left pr-2">Item</th><th className="text-left pr-2">Lot</th><th className="text-left pr-2">From</th><th className="text-left pr-2">Qty</th><th className="text-left">When</th></tr></thead>
            <tbody>{result.used.map((u: any, i: number) => (
              <tr key={i}><td className="pr-2">{u.reference}</td><td className="pr-2">{item(u.serial_number)} <span className="text-on-surface-variant">{u.name}</span></td>
                <td className="pr-2">{u.lot ?? <span className="text-outline">no lot</span>}</td><td className="pr-2">{u.location_code ?? ''}</td><td className="pr-2 font-mono">{fmtNumber(u.qty)}</td><td className="text-outline">{when(u.at)}</td></tr>
            ))}</tbody></table>
        )
      )}
    </div>
  );
}
