import React, { useState } from 'react';
import { Camera, Check, ClipboardList, Loader2, MapPin, Plus, Search, Trash2, X } from 'lucide-react';
import { api, type FindResult, type FoundItem, type Location } from './api';
import { CodeScanner } from './CodeScanner';
import { big, card, field, label } from './ui';

// Counting stock with the phone: scan an item, check how many are at each of
// its places, change what's wrong and save. Saving changes stock straight
// away (no approval): it is posted as a stock count of that item, with its
// own number under Stock > Locations & Counts > Counts, and the difference is
// a STOCK-COUNT movement on the item under the name of who counted.

export interface Place { key: string; binId: number | null; locationId: number | null; code: string | null; lot: string | null; dateCode: string | null; qty: number }
export interface Added { key: string; locationId: number | null; counted: string }
export type Entry = { binId: number | null; locationId: number | null; lot: string | null; counted: number };

/** The item's places from GET /api/inventory/:serial/places: each bin, then what isn't put away. */
export function placesFrom(p: { bins: Array<{ id: number; location_id: number | null; location_code: string | null; lot: string | null; date_code?: string | null; qty: number }>; unplaced: number }): Place[] {
  const rows: Place[] = p.bins.map(b => ({ key: `b${b.id}`, binId: b.id, locationId: b.location_id, code: b.location_code, lot: b.lot, dateCode: b.date_code ?? null, qty: Number(b.qty) || 0 }));
  if (p.unplaced > 0 || !rows.length) rows.push({ key: 'none', binId: null, locationId: null, code: null, lot: null, dateCode: null, qty: Math.max(0, Number(p.unplaced) || 0) });
  return rows;
}

/** What to send: each place whose count differs from what Tracklab says, and each place added. */
export function countEntries(places: Place[], values: Record<string, string>, added: Added[]): Entry[] {
  const out: Entry[] = [];
  for (const p of places) {
    const v = values[p.key];
    if (v === undefined || v === '' || Number(v) === p.qty) continue;
    out.push({ binId: p.binId, locationId: p.binId === null ? p.locationId : null, lot: p.binId === null ? p.lot : null, counted: Number(v) });
  }
  for (const a of added) if (a.counted !== '' && Number(a.counted) > 0) out.push({ binId: null, locationId: a.locationId, lot: null, counted: Number(a.counted) });
  return out;
}

const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');

export const CountJob: React.FC<{ locations: Location[]; onClose: () => void; onError: (e: unknown) => void }> = ({ locations, onClose, onError }) => {
  const [camera, setCamera] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [item, setItem] = useState<{ found: FoundItem; stock: number; places: Place[] } | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [added, setAdded] = useState<Added[]>([]);

  const clear = () => { setItem(null); setValues({}); setAdded([]); setTyped(''); };

  const lookUp = async (code: string) => {
    if (!code.trim()) return;
    setBusy(true); setMsg(null);
    try {
      const found = await api<FindResult>(`/api/stock-moves/find?code=${encodeURIComponent(code)}`);
      const it = found.items.length === 1 ? found.items[0] : found.exact ? found.items[0] : null;
      if (!it) {
        setMsg({ text: found.items.length > 1 ? `That matches ${found.items.length} items: scan the item's own label or type its stock code.` : found.location ? `${found.location.code} is a location. Scan an item to count it.` : 'Not found in Tracklab. Check the code.', bad: true });
        return;
      }
      const p = await api<{ item: { stock: number }; bins: any[]; unplaced: number }>(`/api/inventory/${encodeURIComponent(it.partNumber)}/places`);
      const places = placesFrom(p);
      setItem({ found: it, stock: Number(p.item.stock) || 0, places });
      setValues(Object.fromEntries(places.map(pl => [pl.key, String(pl.qty)])));
      setAdded([]);
      setTyped('');
    } catch (e) { onError(e); } finally { setBusy(false); }
  };

  const entries = item ? countEntries(item.places, values, added) : [];
  const newTotal = item ? item.places.reduce((s, p) => s + (values[p.key] === '' || values[p.key] === undefined ? p.qty : Number(values[p.key])), 0) + added.reduce((s, a) => s + (Number(a.counted) || 0), 0) : 0;

  const save = async () => {
    if (!item) return;
    if (!entries.length) { setMsg({ text: `${item.found.partNumber}: no change, ${item.stock} as Tracklab says.` }); clear(); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await api<{ number: string; stock: number; change: number }>('/api/stock-counts/quick', { method: 'POST', body: { serialNumber: item.found.partNumber, counts: entries } });
      setMsg({ text: `${item.found.partNumber} counted: stock ${item.stock} → ${r.stock} (${signed(r.change)}). Saved as ${r.number}.` });
      clear();
    } catch (e) { onError(e); } finally { setBusy(false); }
  };

  return (
    <>
      <section className={`${card} overflow-hidden`} aria-label="Count stock">
        <div className="px-4 py-3 border-b border-white/[0.07] bg-primary/10 flex items-center gap-2" data-no-mobile-stack>
          <ClipboardList className="w-4 h-4 text-primary shrink-0" aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-black">Count stock</p>
            <p className="text-xs text-on-surface-variant">Saving changes stock straight away</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Stop counting" className="-m-1 p-1 text-on-surface-variant"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-4">
          {msg && <p role={msg.bad ? 'alert' : 'status'} className={`rounded-xl border text-sm font-semibold px-3.5 py-3 ${msg.bad ? 'border-error/25 bg-error/10 text-error' : 'border-green-500/25 bg-green-500/10 text-green-400'}`}>{msg.text}</p>}

          {!item && (
            <>
              <button type="button" onClick={() => { setMsg(null); setCamera(true); }} disabled={busy} className="w-full flex flex-col items-center justify-center gap-2 py-7 rounded-2xl border-2 border-dashed border-primary/40 bg-primary/5 active:scale-[0.98] disabled:opacity-40">
                <span className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary text-black shadow-lg"><Camera className="w-7 h-7" aria-hidden="true" /></span>
                <span className="text-base font-black">Scan an item to count</span>
                <span className="text-xs text-on-surface-variant">Then check the quantity at each place</span>
              </button>
              <form onSubmit={(e) => { e.preventDefault(); void lookUp(typed); }} className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none" aria-hidden="true" />
                  <input className={`${field} !pl-10`} value={typed} onChange={e => setTyped(e.target.value)} placeholder="Stock code" aria-label="Stock code to count" autoCapitalize="characters" autoCorrect="off" enterKeyHint="search" />
                </div>
                <button type="submit" disabled={busy || !typed.trim()} className="px-5 rounded-xl bg-surface-container-high border border-white/10 font-bold disabled:opacity-40 inline-flex items-center gap-1.5">{busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : null}Find</button>
              </form>
            </>
          )}

          {item && (
            <div className="space-y-3">
              <div className="flex items-start gap-2" data-no-mobile-stack>
                <div className="min-w-0 flex-1">
                  <p className="font-mono font-black text-lg text-primary break-all leading-tight">{item.found.partNumber}</p>
                  <p className="text-sm">{item.found.name}</p>
                  <p className="text-xs text-on-surface-variant mt-1">In Tracklab: <strong className="font-mono text-on-surface">{item.stock}</strong>{newTotal !== item.stock && <> · after this count: <strong className="font-mono text-on-surface">{newTotal}</strong> ({signed(newTotal - item.stock)})</>}</p>
                </div>
                <button type="button" onClick={() => { clear(); setMsg(null); }} aria-label="Scan another item" className="-m-1 p-1 text-on-surface-variant"><X className="w-4 h-4" /></button>
              </div>

              <p className={label}>How many are at each place</p>
              {item.places.map(p => {
                const v = values[p.key] ?? '';
                const changed = v !== '' && Number(v) !== p.qty;
                return (
                  <div key={p.key} className={`rounded-xl border p-3 space-y-2 ${changed ? 'border-primary/50 bg-primary/5' : 'border-white/10 bg-surface-container-low'}`}>
                    <p className="text-xs text-on-surface-variant flex flex-wrap items-center gap-x-1.5" data-no-mobile-stack>
                      {p.code ? <><MapPin className="w-3 h-3" aria-hidden="true" /><span className="font-mono font-bold text-on-surface">{p.code}</span></> : <span className="font-bold text-on-surface">No location</span>}
                      {p.lot && <span>· lot <span className="font-mono">{p.lot}</span></span>}
                      {p.dateCode && <span>· D/C {p.dateCode}</span>}
                      <span className="ml-auto">Tracklab says <span className="font-mono">{p.qty}</span></span>
                    </p>
                    <input className={`${field} font-mono text-xl font-black text-center`} inputMode="numeric" pattern="[0-9]*" value={v}
                      onChange={e => setValues(s => ({ ...s, [p.key]: e.target.value.replace(/[^\d]/g, '') }))} onFocus={e => e.target.select()}
                      aria-label={`How many ${item.found.partNumber} ${p.code ? `at ${p.code}` : 'with no location'}${p.lot ? ` lot ${p.lot}` : ''}`} />
                    {changed && <p className="text-[11px] font-bold text-primary">{signed(Number(v) - p.qty)}</p>}
                  </div>
                );
              })}

              {added.map(a => (
                <div key={a.key} className="rounded-xl border border-primary/50 bg-primary/5 p-3 space-y-2">
                  <div className="flex gap-2">
                    <select className={`${field} flex-1 !py-2.5`} value={a.locationId ?? ''} aria-label="Where it was found"
                      onChange={e => setAdded(xs => xs.map(x => (x.key === a.key ? { ...x, locationId: e.target.value ? Number(e.target.value) : null } : x)))}>
                      <option value="">No location</option>
                      {locations.map(l => <option key={l.id} value={l.id}>{l.code}{l.name ? ` · ${l.name}` : ''}</option>)}
                    </select>
                    <button type="button" onClick={() => setAdded(xs => xs.filter(x => x.key !== a.key))} aria-label="Remove this place" className="px-3 rounded-xl border border-white/10 text-on-surface-variant"><Trash2 className="w-4 h-4" /></button>
                  </div>
                  <input className={`${field} font-mono text-xl font-black text-center`} inputMode="numeric" pattern="[0-9]*" value={a.counted} placeholder="How many"
                    onChange={e => setAdded(xs => xs.map(x => (x.key === a.key ? { ...x, counted: e.target.value.replace(/[^\d]/g, '') } : x)))} aria-label="How many found there" />
                </div>
              ))}
              <button type="button" onClick={() => setAdded(xs => [...xs, { key: `a${Date.now()}`, locationId: null, counted: '' }])} className="w-full rounded-xl border border-dashed border-white/15 py-2.5 text-sm font-bold text-on-surface-variant inline-flex items-center justify-center gap-1.5">
                <Plus className="w-4 h-4" aria-hidden="true" />Found some somewhere else
              </button>

              <button type="button" disabled={busy} onClick={() => void save()} className={`${big} bg-primary text-black shadow-lg`}>
                {busy ? <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" /> : <Check className="w-5 h-5" aria-hidden="true" />}
                {busy ? 'Saving…' : entries.length ? `Save count: stock ${newTotal}` : 'Save: it matches'}
              </button>
              <p className="text-xs text-on-surface-variant text-center -mt-1">Stock changes as soon as you save. It's recorded as a stock count under your name.</p>
            </div>
          )}
        </div>
      </section>

      {camera && (
        <CodeScanner
          title="Scan an item to count"
          hint="Point at the reel or item label"
          onClose={() => setCamera(false)}
          onCode={(code) => { setCamera(false); void lookUp(code); }}
        />
      )}
    </>
  );
};
