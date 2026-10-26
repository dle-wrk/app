// The item view's Places tab: where its stock is (location and lot), what has
// no location yet, putting it away or moving it, and its recent moves.
// Server: src/lib/stockPlaces.ts.

import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, MapPin } from 'lucide-react';
import { canChange } from '../lib/changeAccess';
import { fmtNumber } from '../lib/formatMoney';

interface Bin { id: number; location_id: number | null; location_code: string | null; location_name: string | null; lot: string | null; date_code: string | null; qty: number; received_at: string }
interface Places { item: { stock: number }; bins: Bin[]; unplaced: number; placed: number; over: number; moves: any[] }
const input = 'bg-surface-container border border-outline-variant rounded px-2 py-1.5 text-xs text-on-surface';
const when = (d: string) => new Date(d).toLocaleString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
const REASON: Record<string, string> = { 'put away': 'Put away', moved: 'Moved', used: 'Used', counted: 'Counted', returned: 'Returned' };

export default function ItemPlaces({ serialNumber, onChanged }: { serialNumber: string; onChanged?: () => void }) {
  const may = canChange('/api/inventory/x/places/move');
  const [data, setData] = useState<Places | null>(null);
  const [locations, setLocations] = useState<Array<{ id: number; code: string; name: string | null; active: boolean }>>([]);
  const [move, setMove] = useState<{ from: string; qty: string; to: string; lot: string; dateCode: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, l] = await Promise.all([fetch(`/api/inventory/${encodeURIComponent(serialNumber)}/places`).then((r) => r.json()), fetch('/api/stock-locations').then((r) => r.json())]);
      setData(p); setLocations(l.locations ?? []);
    } catch (e: any) { setError(e?.message || String(e)); }
  }, [serialNumber]);
  useEffect(() => { void load(); }, [load]);

  const submit = async () => {
    if (!move) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/inventory/${encodeURIComponent(serialNumber)}/places/move`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qty: Number(move.qty), fromBinId: move.from === 'none' ? null : Number(move.from), toLocationId: move.to === 'none' ? null : Number(move.to), lot: move.lot, dateCode: move.dateCode }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.error || 'Could not move it.'); return; }
      setMove(null); await load(); onChanged?.();
    } finally { setBusy(false); }
  };

  if (error && !data) return <p className="text-xs text-error">{error}</p>;
  if (!data) return <p className="text-xs text-outline flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</p>;
  const fromBin = move && move.from !== 'none' ? data.bins.find((b) => String(b.id) === move.from) : null;
  const max = move ? (fromBin ? fromBin.qty : data.unplaced) : 0;

  return (
    <div className="space-y-sm text-xs" data-testid="item-places">
      <div className="flex flex-wrap items-center justify-between gap-sm">
        <span className="text-on-surface-variant">{fmtNumber(data.item.stock)} in stock: {fmtNumber(data.placed)} in places, {fmtNumber(data.unplaced)} with no location.
          {data.over > 0 && <span className="text-amber-500"> The places hold {fmtNumber(data.over)} more than the stock: count it.</span>}</span>
        {may && !move && (data.unplaced > 0 || data.bins.length > 0) && (
          <button type="button" className="text-primary font-bold hover:underline inline-flex items-center gap-1" onClick={() => setMove({ from: data.unplaced > 0 ? 'none' : String(data.bins[0].id), qty: String(data.unplaced > 0 ? data.unplaced : data.bins[0].qty), to: '', lot: '', dateCode: '' })}>
            <MapPin className="w-3.5 h-3.5" /> {data.unplaced > 0 ? 'Put away' : 'Move'}
          </button>
        )}
      </div>
      {move && (
        <div className="rounded-lg border border-outline-variant bg-surface-container-high/40 p-sm grid grid-cols-2 md:grid-cols-6 gap-sm items-end">
          <label className="text-[10px] text-outline md:col-span-2">From<select className={`${input} w-full mt-0.5`} value={move.from} onChange={(e) => setMove({ ...move, from: e.target.value })} aria-label="Move from">
            {data.unplaced > 0 && <option value="none">No location ({fmtNumber(data.unplaced)})</option>}
            {data.bins.map((b) => <option key={b.id} value={b.id}>{b.location_code ?? 'No location'}{b.lot ? ` · lot ${b.lot}` : ''} ({fmtNumber(b.qty)})</option>)}
          </select></label>
          <label className="text-[10px] text-outline">Qty (max {fmtNumber(max)})<input className={`${input} w-full mt-0.5 font-mono`} inputMode="numeric" value={move.qty} onChange={(e) => setMove({ ...move, qty: e.target.value.replace(/[^0-9]/g, '') })} aria-label="Quantity to move" /></label>
          <label className="text-[10px] text-outline">To<select className={`${input} w-full mt-0.5`} value={move.to} onChange={(e) => setMove({ ...move, to: e.target.value })} aria-label="Move to">
            <option value="">Choose…</option>{locations.filter((l) => l.active).map((l) => <option key={l.id} value={l.id}>{l.code}{l.name ? ` · ${l.name}` : ''}</option>)}
            {move.from !== 'none' && <option value="none">No location</option>}
          </select></label>
          {move.from === 'none' ? <>
            <label className="text-[10px] text-outline">Lot (optional)<input className={`${input} w-full mt-0.5`} value={move.lot} onChange={(e) => setMove({ ...move, lot: e.target.value })} aria-label="Lot" /></label>
            <label className="text-[10px] text-outline">Date code (optional)<input className={`${input} w-full mt-0.5`} value={move.dateCode} onChange={(e) => setMove({ ...move, dateCode: e.target.value })} aria-label="Date code" /></label>
          </> : <span className="md:col-span-2 text-[10px] text-outline">Keeps its lot{fromBin?.lot ? ` (${fromBin.lot})` : ''}.</span>}
          <div className="col-span-2 md:col-span-6 flex justify-end gap-sm">
            {error && <span className="text-error mr-auto">{error}</span>}
            <button type="button" className="px-3 py-1.5 rounded border border-outline-variant" onClick={() => { setMove(null); setError(null); }}>Cancel</button>
            <button type="button" className="px-3 py-1.5 rounded bg-primary text-on-primary font-bold disabled:opacity-50" disabled={busy || !move.qty || !move.to || Number(move.qty) > max} onClick={() => void submit()}>{busy ? 'Moving…' : 'Move'}</button>
          </div>
          {locations.length === 0 && <p className="col-span-2 md:col-span-6 text-[10px] text-amber-500">No locations yet: add them under Stock &gt; Locations &amp; Counts.</p>}
        </div>
      )}
      <div className="rounded-xl border border-outline-variant/60 overflow-x-auto">
        <table className="w-full text-left">
          <thead><tr className="text-[10px] text-outline uppercase tracking-wider bg-surface-container-high/30"><th className="px-md py-2">Location</th><th className="px-md py-2">Lot</th><th className="px-md py-2">Date code</th><th className="px-md py-2 text-right">Qty</th><th className="px-md py-2">Since</th></tr></thead>
          <tbody className="divide-y divide-outline-variant/30">
            {data.bins.map((b) => (
              <tr key={b.id}><td className="px-md py-1.5 font-mono font-bold">{b.location_code ?? <span className="text-outline font-sans font-normal">No location</span>}</td><td className="px-md py-1.5">{b.lot ?? ''}</td><td className="px-md py-1.5">{b.date_code ?? ''}</td><td className="px-md py-1.5 text-right font-mono">{fmtNumber(b.qty)}</td><td className="px-md py-1.5 text-outline">{when(b.received_at)}</td></tr>
            ))}
            {data.unplaced > 0 && <tr><td className="px-md py-1.5 text-outline">No location</td><td /><td /><td className="px-md py-1.5 text-right font-mono">{fmtNumber(data.unplaced)}</td><td /></tr>}
          </tbody>
        </table>
      </div>
      {data.moves.length > 0 && (
        <details><summary className="cursor-pointer text-outline">Recent moves</summary>
          <table className="w-full text-[11px] mt-1"><tbody>{data.moves.map((m: any) => (
            <tr key={m.id}><td className="pr-2 text-outline whitespace-nowrap">{when(m.at)}</td><td className="pr-2">{REASON[m.reason] ?? m.reason}</td><td className={`pr-2 font-mono ${m.qty < 0 ? 'text-error' : ''}`}>{m.qty > 0 ? '+' : ''}{fmtNumber(m.qty)}</td>
              <td className="pr-2">{m.location_code ?? ''}{m.lot ? ` · lot ${m.lot}` : ''}</td><td className="text-on-surface-variant">{m.movement ?? m.reference ?? ''}{m.by_user ? ` · ${m.by_user}` : ''}</td></tr>
          ))}</tbody></table>
        </details>
      )}
    </div>
  );
}
