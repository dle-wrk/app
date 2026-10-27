// Stock > Locations & Counts > Scan: a barcode scanner (or the keyboard)
// types a code and Enter. Scan a bin label, then items, to put them away or
// move them there; scan an item alone to see where it's kept. Also prints the
// bin and item labels. Codes: src/lib/stockLabels.ts; server: src/lib/stockPlaces.ts.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, MapPin, ScanLine, Printer, ClipboardList, X } from 'lucide-react';
import { canChange } from '../lib/changeAccess';
import { fmtNumber } from '../lib/formatMoney';
import { readScan, printLabels, type Label } from '../lib/stockLabels';
import { PrimaryButton, SecondaryButton } from './bookkeeping/shared';
import type { Item } from '../types';

type Toast = (msg: string, type?: string) => void;
interface Loc { id: number; code: string; name: string | null; active: boolean; items: number; units: number }
interface Bin { id: number; location_id: number | null; location_code: string | null; lot: string | null; qty: number }
interface Places { item: { serial_number: string; name: string | null; stock: number }; bins: Bin[]; unplaced: number }

const input = 'bg-surface-container border border-outline-variant rounded px-3 py-2 text-sm text-on-surface';

async function api<T = any>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init && init.body ? { ...init, headers: { 'Content-Type': 'application/json' } } : init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

function Labels({ items, locations, triggerToast }: { items: Item[]; locations: Loc[]; triggerToast: Toast }) {
  const [kind, setKind] = useState<'bin' | 'item'>('bin');
  const [prefix, setPrefix] = useState('');
  const chosen: Label[] = useMemo(() => {
    const p = prefix.trim().toUpperCase();
    return kind === 'bin'
      ? locations.filter((l) => l.active && l.code.startsWith(p)).map((l) => ({ kind: 'bin' as const, code: l.code, title: l.name }))
      : items.filter((i) => i.partNumber.toUpperCase().startsWith(p)).map((i) => ({ kind: 'item' as const, code: i.partNumber, title: i.name }));
  }, [kind, prefix, items, locations]);
  const sheets = Math.ceil(chosen.length / 21);
  return (
    <div className="rounded-xl border border-outline-variant bg-surface-container-high p-md space-y-sm" data-testid="labels">
      <p className="text-xs font-bold text-on-surface flex items-center gap-1.5"><Printer className="w-3.5 h-3.5" /> Print labels</p>
      <div className="flex flex-wrap items-center gap-sm">
        <div className="flex gap-1" role="radiogroup" aria-label="Labels for">
          {([['bin', 'Bins'], ['item', 'Items']] as const).map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold border ${kind === k ? 'bg-primary text-on-primary border-primary' : 'border-outline-variant text-on-surface-variant hover:text-on-surface'}`}>{label}</button>
          ))}
        </div>
        <input className={`${input} w-56 py-1.5 text-xs font-mono`} value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="Only codes starting with… (optional)" aria-label="Labels starting with" />
        <span className="text-xs text-outline">{fmtNumber(chosen.length)} label{chosen.length === 1 ? '' : 's'}{chosen.length ? `, ${fmtNumber(sheets)} sheet${sheets === 1 ? '' : 's'}` : ''}</span>
        <PrimaryButton type="button" disabled={!chosen.length} icon={<Printer className="w-3.5 h-3.5" />}
          onClick={() => { if (!printLabels(chosen)) triggerToast('The print window was blocked: allow pop-ups for this site.', 'ERROR'); }}>Print</PrimaryButton>
      </div>
      <p className="text-[11px] text-outline">A4 sheets of 21 labels (3 across, 7 down, 63.5 × 38.1 mm). A bin label's barcode starts with LOC: so a scan can tell a bin from an item, even when the bin is named after its item.</p>
    </div>
  );
}

export default function StockScan({ triggerToast, items = [], onOpenItem, onOpenCount }: { triggerToast: Toast; items?: Item[]; onOpenItem?: (s: string) => void; onOpenCount?: (id: number) => void }) {
  const may = canChange('/api/inventory/x/places/move');
  const [locations, setLocations] = useState<Loc[] | null>(null);
  const [scan, setScan] = useState('');
  const [bin, setBin] = useState<Loc | null>(null);
  const [places, setPlaces] = useState<Places | null>(null);
  const [from, setFrom] = useState('none');
  const [qty, setQty] = useState('');
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const scanRef = useRef<HTMLInputElement>(null);
  const qtyRef = useRef<HTMLInputElement>(null);
  const itemByCode = useMemo(() => new Map(items.map((i) => [i.partNumber.toUpperCase(), i])), [items]);
  const binByCode = useMemo(() => new Map((locations ?? []).map((l) => [l.code.toUpperCase(), l])), [locations]);

  const loadLocations = useCallback(async () => { try { setLocations((await api('/api/stock-locations')).locations); } catch (e: any) { triggerToast(e.message, 'ERROR'); } }, [triggerToast]);
  useEffect(() => { void loadLocations(); }, [loadLocations]);
  const refocus = () => setTimeout(() => scanRef.current?.focus(), 0);

  /** Loads an item's places and picks what to move into the bin: what isn't put away first, else another bin. */
  const showItem = async (serial: string, here: Loc | null) => {
    const p: Places = await api(`/api/inventory/${encodeURIComponent(serial)}/places`);
    setPlaces(p);
    const other = p.bins.find((b) => b.location_id !== here?.id);
    const f = p.unplaced > 0 ? 'none' : other ? String(other.id) : '';
    setFrom(f); setQty(f === 'none' ? String(p.unplaced) : other ? String(other.qty) : '');
    return f;
  };

  const onScan = async (text: string) => {
    setScan(''); setMessage(null);
    const s = readScan(text);
    if (!s) return;
    try {
      if (s.kind === 'bin') {
        const l = binByCode.get(s.code);
        if (!l) { setMessage({ text: `There is no bin ${s.code}. Add it under Locations.`, bad: true }); return; }
        setBin(l); setPlaces(null); setMessage({ text: `At ${l.code}. Now scan the items going in it.` });
        return;
      }
      const item = itemByCode.get(s.code.toUpperCase());
      if (item) {
        // No bin yet, but one is named after this item: that's where it goes.
        const here = bin ?? binByCode.get(item.partNumber.toUpperCase()) ?? null;
        if (here !== bin) setBin(here);
        const f = await showItem(item.partNumber, here);
        if (here && f && may) setTimeout(() => { qtyRef.current?.focus(); qtyRef.current?.select(); }, 0);
        return;
      }
      const l = binByCode.get(s.code.toUpperCase());
      if (l) { setBin(l); setPlaces(null); setMessage({ text: `At ${l.code}. Now scan the items going in it.` }); return; }
      setMessage({ text: `Nothing has the code ${s.code}.`, bad: true });
    } catch (e: any) { setMessage({ text: e.message, bad: true }); }
  };

  const fromBin = places && from !== 'none' ? places.bins.find((b) => String(b.id) === from) : null;
  const max = places ? (from === 'none' ? places.unplaced : fromBin?.qty ?? 0) : 0;
  const putAway = async () => {
    if (!bin || !places || !(Number(qty) > 0) || Number(qty) > max) return;
    setBusy(true);
    try {
      const serial = places.item.serial_number;
      await api(`/api/inventory/${encodeURIComponent(serial)}/places/move`, { method: 'POST', body: JSON.stringify({ qty: Number(qty), fromBinId: from === 'none' ? null : Number(from), toLocationId: bin.id }) });
      setMessage({ text: `${fmtNumber(Number(qty))} of ${serial} ${from === 'none' ? 'put away' : `moved from ${fromBin?.location_code ?? ''}`} in ${bin.code}. Scan the next item.` });
      await showItem(serial, bin); void loadLocations();
    } catch (e: any) { setMessage({ text: e.message, bad: true }); } finally { setBusy(false); refocus(); }
  };
  const checkBin = async () => {
    if (!bin) return;
    try { const r = await api('/api/stock-counts', { method: 'POST', body: JSON.stringify({ scope: 'location', locationId: bin.id }) }); onOpenCount?.(r.id); }
    catch (e: any) { triggerToast(e.message, 'ERROR'); }
  };

  if (!locations) return <p className="text-xs text-outline flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</p>;
  const inHere = places && bin ? places.bins.filter((b) => b.location_id === bin.id).reduce((s, b) => s + b.qty, 0) : 0;
  const elsewhere = places ? places.bins.filter((b) => b.location_id !== bin?.id) : [];
  return (
    <div className="space-y-md" data-testid="stock-scan">
      <p className="text-xs text-on-surface-variant max-w-[760px] leading-relaxed">Scan a bin label, then each item going in it. Scan an item on its own to see where it's kept. A scanner types the code and presses Enter; typing a code and pressing Enter works too.</p>
      <div className="flex flex-wrap items-center gap-sm">
        <div className="relative w-full sm:w-96">
          <ScanLine className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-outline" />
          <input ref={scanRef} autoFocus className={`${input} w-full pl-9 py-3 font-mono text-base`} value={scan} onChange={(e) => setScan(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void onScan(scan); } }} placeholder="Scan or type a code" aria-label="Scan" />
        </div>
        {bin
          ? <span className="inline-flex items-center gap-1.5 rounded-lg bg-primary/10 text-primary px-3 py-2 text-xs font-bold" data-testid="scan-bin"><MapPin className="w-3.5 h-3.5" />{bin.code}{bin.name ? <span className="font-normal text-on-surface-variant">{bin.name}</span> : null}
              <button type="button" aria-label="Leave this bin" className="ml-1" onClick={() => { setBin(null); setPlaces(null); setMessage(null); refocus(); }}><X className="w-3.5 h-3.5" /></button></span>
          : <span className="text-xs text-outline">No bin scanned.</span>}
        {bin && canChange('/api/stock-counts') && <SecondaryButton type="button" icon={<ClipboardList className="w-3.5 h-3.5" />} onClick={() => void checkBin()}>Check this bin</SecondaryButton>}
      </div>
      {message && <p className={`text-xs ${message.bad ? 'text-error' : 'text-on-surface'}`} role="status">{message.text}</p>}
      {places && (
        <div className="rounded-xl border border-outline-variant p-md space-y-sm text-xs" data-testid="scan-item">
          <p className="text-on-surface">
            {onOpenItem ? <button type="button" className="font-mono font-bold text-primary hover:underline" onClick={() => onOpenItem(places.item.serial_number)}>{places.item.serial_number}</button> : <strong className="font-mono">{places.item.serial_number}</strong>}
            {places.item.name ? ` ${places.item.name}` : ''}: {fmtNumber(places.item.stock)} in stock.
          </p>
          <p className="text-on-surface-variant">
            Kept in: {places.bins.filter((b) => b.location_code).map((b) => `${b.location_code} (${fmtNumber(b.qty)}${b.lot ? `, lot ${b.lot}` : ''})`).join(', ') || 'no bin yet'}
            {places.unplaced > 0 ? `; ${fmtNumber(places.unplaced)} not put away yet.` : '.'}
          </p>
          {bin && may && (places.unplaced > 0 || elsewhere.length > 0) ? (
            <div className="flex flex-wrap items-end gap-sm">
              <label className="text-[10px] text-outline">From<select className={`${input} block mt-0.5 py-1.5 text-xs`} value={from} onChange={(e) => { setFrom(e.target.value); const b = places.bins.find((x) => String(x.id) === e.target.value); setQty(String(e.target.value === 'none' ? places.unplaced : b?.qty ?? '')); }} aria-label="Scan move from">
                {places.unplaced > 0 && <option value="none">Not put away yet ({fmtNumber(places.unplaced)})</option>}
                {elsewhere.map((b) => <option key={b.id} value={b.id}>{b.location_code ?? 'Not put away yet'}{b.lot ? ` · lot ${b.lot}` : ''} ({fmtNumber(b.qty)})</option>)}
              </select></label>
              <label className="text-[10px] text-outline">How many into {bin.code}<input ref={qtyRef} className={`${input} block mt-0.5 py-1.5 w-28 text-right font-mono`} inputMode="numeric" value={qty}
                onChange={(e) => setQty(e.target.value.replace(/[^0-9]/g, ''))} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void putAway(); } if (e.key === 'Escape') refocus(); }} aria-label="How many into the bin" /></label>
              <PrimaryButton type="button" disabled={busy || !(Number(qty) > 0) || Number(qty) > max} onClick={() => void putAway()}>{busy ? 'Putting away…' : from === 'none' ? `Put away in ${bin.code}` : `Move to ${bin.code}`}</PrimaryButton>
              {inHere > 0 && <span className="text-outline">{fmtNumber(inHere)} already here.</span>}
            </div>
          ) : bin ? (
            <p className={inHere > 0 ? 'text-green-500' : 'text-outline'}>{inHere > 0 ? `All ${fmtNumber(inHere)} are in ${bin.code}.` : 'Nothing of it to put away.'}</p>
          ) : <p className="text-outline">Scan a bin label first to put it away.</p>}
        </div>
      )}
      <Labels items={items} locations={locations} triggerToast={triggerToast} />
    </div>
  );
}
