import React, { useCallback, useEffect, useState } from 'react';
import { Camera, Check, ChevronRight, ClipboardList, Loader2, MapPin, Plus, Search, X } from 'lucide-react';
import { api, type CountDetail, type CountLine, type CountSummary, type FindResult, type FoundItem, type Location } from './api';
import { CodeScanner } from './CodeScanner';
import { big, card, field, label } from './ui';

// Counting stock with the phone: open a stock count (or start one for a
// location by scanning its label), then scan each item there and enter how
// many there are. Each count is saved on the count straight away; stock
// changes only when the count is posted on the website (Stock > Locations &
// Counts > Counts), which shows the differences first. The phone doesn't show
// what the system expects, so the count is what is really on the shelf.

const same = (a: string | null | undefined, b: string | null | undefined) => String(a ?? '').trim().toUpperCase() === String(b ?? '').trim().toUpperCase();

/** The count after this entry: added to what was counted already, or set to it. */
export const nextCount = (current: number | null, n: number, how: 'add' | 'set') => (how === 'add' ? (current ?? 0) + n : n);

/** The lines of a count for a scanned item, those with the scanned lot first. */
export function linesFor(lines: CountLine[], serial: string, lot?: string | null): CountLine[] {
  const mine = lines.filter(l => same(l.serial_number, serial));
  return lot ? [...mine.filter(l => same(l.lot, lot)), ...mine.filter(l => !same(l.lot, lot))] : mine;
}

export const CountJob: React.FC<{ locations: Location[]; onClose: () => void; onError: (e: unknown) => void }> = ({ locations, onClose, onError }) => {
  const [counts, setCounts] = useState<CountSummary[] | null>(null);
  const [open, setOpen] = useState<CountDetail | null>(null);
  const [camera, setCamera] = useState<null | 'item' | 'place'>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [item, setItem] = useState<{ found: FoundItem; lines: CountLine[]; labelQty: number | null } | null>(null);
  const [amounts, setAmounts] = useState<Record<number, string>>({});
  const [placeId, setPlaceId] = useState('');

  const fail = useCallback((e: unknown) => { setBusy(false); onError(e); }, [onError]);
  const loadCounts = useCallback(() => {
    api<CountSummary[]>('/api/stock-counts').then(r => setCounts((r || []).filter(c => c.status === 'OPEN'))).catch(e => { setCounts([]); onError(e); });
  }, [onError]);
  useEffect(() => { loadCounts(); }, [loadCounts]);
  const reload = async (id: number) => { const d = await api<CountDetail>(`/api/stock-counts/${id}`); setOpen(d); return d; };

  const openCount = async (id: number) => { setBusy(true); setMsg(null); try { await reload(id); } catch (e) { onError(e); } finally { setBusy(false); } };

  const start = async (locationId: number) => {
    setBusy(true); setMsg(null);
    try {
      const r = await api<{ id: number; number: string }>('/api/stock-counts', { method: 'POST', body: { scope: 'location', locationId } });
      await reload(r.id);
      setMsg({ text: `Count ${r.number} started. Scan each item on the shelf.` });
    } catch (e) { onError(e); } finally { setBusy(false); }
  };

  /** A scanned or typed code: a location label starts a count there; an item shows its lines to count. */
  const lookUp = async (code: string) => {
    if (!code.trim()) return;
    setBusy(true); setMsg(null);
    try {
      const found = await api<FindResult>(`/api/stock-moves/find?code=${encodeURIComponent(code)}`);
      if (!open) {
        if (found.location) await start(found.location.id);
        else setMsg({ text: 'That is not a stock location label. Scan the shelf or rack label to count it.', bad: true });
        return;
      }
      const it = found.items.length === 1 ? found.items[0] : found.items.find(i => same(i.partNumber, code)) ?? null;
      if (!it) {
        setMsg({ text: found.items.length > 1 ? `That matches ${found.items.length} items: scan the item's own label or type its stock code.` : found.location ? `${found.location.code} is a location. Scan the items on it.` : 'Not found in Tracklab. Check the code.', bad: true });
        return;
      }
      const lines = linesFor(open.lines, it.partNumber, found.label?.lot);
      setItem({ found: it, lines, labelQty: found.label?.quantity ?? null });
      const q = found.label?.quantity ? String(found.label.quantity) : '';
      setAmounts(lines[0] ? { [lines[0].id]: q } : {});
      setPlaceId(open.count.location_id ? String(open.count.location_id) : '');
      setTyped('');
    } catch (e) { onError(e); } finally { setBusy(false); }
  };

  const save = async (line: CountLine, how: 'add' | 'set') => {
    const n = Number(amounts[line.id]);
    if (!Number.isInteger(n) || n < 0) { setMsg({ text: 'Enter a whole number of 0 or more.', bad: true }); return; }
    setBusy(true); setMsg(null);
    try {
      const counted = nextCount(line.counted, n, how);
      await api(`/api/stock-counts/${open!.count.id}/lines`, { method: 'PUT', body: { lines: [{ id: line.id, counted }] } });
      const d = await reload(open!.count.id);
      setMsg({ text: `${line.serial_number}${line.lot ? ` lot ${line.lot}` : ''}${line.location_code ? ` at ${line.location_code}` : ''}: counted ${counted}. Scan the next item.` });
      setItem(null); setAmounts({});
      void d;
    } catch (e) { fail(e); } finally { setBusy(false); }
  };

  // Something on the shelf the count didn't list: add a line for it, then count it.
  const addLine = async () => {
    if (!item || !open) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api<{ id: number }>(`/api/stock-counts/${open.count.id}/lines`, { method: 'POST', body: { serialNumber: item.found.partNumber, locationId: placeId ? Number(placeId) : null } });
      const d = await reload(open.count.id);
      const lines = linesFor(d.lines, item.found.partNumber);
      setItem({ ...item, lines: [...lines.filter(l => l.id === r.id), ...lines.filter(l => l.id !== r.id)] });
      setAmounts({ [r.id]: item.labelQty ? String(item.labelQty) : '' });
    } catch (e) { fail(e); } finally { setBusy(false); }
  };

  const counted = open ? open.lines.filter(l => l.counted !== null).length : 0;

  return (
    <>
      <section className={`${card} overflow-hidden`} aria-label="Count stock">
        <div className="px-4 py-3 border-b border-white/[0.07] bg-primary/10 flex items-center gap-2" data-no-mobile-stack>
          <ClipboardList className="w-4 h-4 text-primary shrink-0" aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-black truncate">{open ? <>Counting <span className="font-mono">{open.count.number}</span>{open.count.location_code ? <> at <span className="font-mono">{open.count.location_code}</span></> : ''}</> : 'Count stock'}</p>
            {open && <p className="text-xs text-on-surface-variant">{counted} of {open.lines.length} counted</p>}
          </div>
          <button type="button" onClick={open ? () => { setOpen(null); setItem(null); setMsg(null); loadCounts(); } : onClose} aria-label={open ? 'Leave this count' : 'Close'} className="-m-1 p-1 text-on-surface-variant"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-4">
          {msg && <p role={msg.bad ? 'alert' : 'status'} className={`rounded-xl border text-sm font-semibold px-3.5 py-3 ${msg.bad ? 'border-error/25 bg-error/10 text-error' : 'border-green-500/25 bg-green-500/10 text-green-400'}`}>{msg.text}</p>}

          {!open && (
            <>
              <button type="button" onClick={() => setCamera('place')} disabled={busy} className="w-full flex flex-col items-center justify-center gap-2 py-6 rounded-2xl border-2 border-dashed border-primary/40 bg-primary/5 active:scale-[0.98] disabled:opacity-40">
                <span className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary text-black shadow-lg"><MapPin className="w-7 h-7" aria-hidden="true" /></span>
                <span className="text-base font-black">Scan a shelf to count it</span>
                <span className="text-xs text-on-surface-variant">Starts a new count of that location</span>
              </button>
              <div className="flex gap-2">
                <select className={`${field} flex-1`} value={placeId} onChange={e => setPlaceId(e.target.value)} aria-label="Location to count">
                  <option value="">Or choose a location…</option>
                  {locations.map(l => <option key={l.id} value={l.id}>{l.code}{l.name ? ` · ${l.name}` : ''}</option>)}
                </select>
                <button type="button" disabled={!placeId || busy} onClick={() => void start(Number(placeId))} className="px-4 rounded-xl bg-primary text-black font-bold disabled:opacity-40">Start</button>
              </div>
              <div>
                <p className={label}>Counts already open</p>
                {!counts && <p className="text-sm text-on-surface-variant flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />Loading…</p>}
                {counts && !counts.length && <p className="text-sm text-on-surface-variant">None. Start one above, or on the website.</p>}
                <ul className="space-y-1.5">
                  {(counts || []).map(c => (
                    <li key={c.id}>
                      <button type="button" onClick={() => void openCount(c.id)} className="w-full text-left rounded-xl border border-white/10 bg-surface-container-low p-3 flex items-center gap-3 active:border-primary" data-no-mobile-stack>
                        <span className="flex-1 min-w-0">
                          <span className="block font-mono font-bold text-primary">{c.number}</span>
                          <span className="block text-xs text-on-surface-variant">{c.location_code ? `At ${c.location_code}` : c.scope === 'unplaced' ? 'Stock with no location' : c.scope === 'items' ? 'Chosen items' : 'Everything'} · {c.counted} of {c.lines} counted</span>
                        </span>
                        <ChevronRight className="w-4 h-4 text-on-surface-variant" aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}

          {open && !item && (
            <>
              <button type="button" onClick={() => setCamera('item')} disabled={busy} className="w-full flex flex-col items-center justify-center gap-2 py-7 rounded-2xl border-2 border-dashed border-primary/40 bg-primary/5 active:scale-[0.98] disabled:opacity-40">
                <span className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary text-black shadow-lg"><Camera className="w-7 h-7" aria-hidden="true" /></span>
                <span className="text-base font-black">Scan an item to count</span>
              </button>
              <form onSubmit={(e) => { e.preventDefault(); void lookUp(typed); }} className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none" aria-hidden="true" />
                  <input className={`${field} !pl-10`} value={typed} onChange={e => setTyped(e.target.value)} placeholder="Stock code" aria-label="Stock code to count" autoCapitalize="characters" autoCorrect="off" enterKeyHint="search" />
                </div>
                <button type="submit" disabled={busy || !typed.trim()} className="px-5 rounded-xl bg-surface-container-high border border-white/10 font-bold disabled:opacity-40">Find</button>
              </form>
              <p className="text-xs text-on-surface-variant text-center">Counts are saved as you go. Stock changes when the count is posted on the website, under Stock &gt; Locations &amp; Counts &gt; Counts.</p>
            </>
          )}

          {open && item && (
            <div className="space-y-3">
              <div className="flex items-start gap-2" data-no-mobile-stack>
                <div className="min-w-0 flex-1">
                  <p className="font-mono font-black text-lg text-primary break-all leading-tight">{item.found.partNumber}</p>
                  <p className="text-sm">{item.found.name}</p>
                </div>
                <button type="button" onClick={() => { setItem(null); setMsg(null); }} aria-label="Scan another item" className="-m-1 p-1 text-on-surface-variant"><X className="w-4 h-4" /></button>
              </div>
              {item.lines.map(l => (
                <div key={l.id} className="rounded-xl border border-white/10 bg-surface-container-low p-3 space-y-2">
                  <p className="text-xs text-on-surface-variant">
                    {l.location_code ? <><MapPin className="w-3 h-3 inline -mt-0.5" aria-hidden="true" /> <span className="font-mono font-bold text-on-surface">{l.location_code}</span></> : 'No location'}
                    {l.lot ? <> · lot <span className="font-mono">{l.lot}</span></> : ''}{l.date_code ? ` · D/C ${l.date_code}` : ''}{l.added ? ' · added during the count' : ''}
                    {l.counted !== null && <> · <strong className="text-green-400">counted {l.counted}</strong></>}
                  </p>
                  <div className="flex gap-2">
                    <input className={`${field} font-mono text-xl font-black text-center`} inputMode="numeric" pattern="[0-9]*" value={amounts[l.id] ?? ''} placeholder="How many"
                      onChange={e => setAmounts(a => ({ ...a, [l.id]: e.target.value.replace(/[^\d]/g, '') }))} aria-label={`How many ${l.serial_number}${l.lot ? ` lot ${l.lot}` : ''}${l.location_code ? ` at ${l.location_code}` : ''}`} />
                    {l.counted !== null ? (
                      <>
                        <button type="button" disabled={busy || amounts[l.id] === undefined || amounts[l.id] === ''} onClick={() => void save(l, 'add')} className="px-3 rounded-xl bg-primary text-black font-bold disabled:opacity-40 inline-flex items-center gap-1"><Plus className="w-4 h-4" aria-hidden="true" />Add</button>
                        <button type="button" disabled={busy || amounts[l.id] === undefined || amounts[l.id] === ''} onClick={() => void save(l, 'set')} className="px-3 rounded-xl border border-white/10 bg-surface-container-high font-bold disabled:opacity-40">Set</button>
                      </>
                    ) : (
                      <button type="button" disabled={busy || amounts[l.id] === undefined || amounts[l.id] === ''} onClick={() => void save(l, 'set')} className="px-4 rounded-xl bg-primary text-black font-bold disabled:opacity-40 inline-flex items-center gap-1"><Check className="w-4 h-4" aria-hidden="true" />Save</button>
                    )}
                  </div>
                  {l.counted !== null && <p className="text-[11px] text-on-surface-variant">Add puts this reel on top of the {l.counted} counted; Set replaces it.</p>}
                </div>
              ))}
              {!item.lines.length && <p className="text-sm text-on-surface-variant">This count doesn't list {item.found.partNumber}{open.count.location_code ? ` at ${open.count.location_code}` : ''}.</p>}
              <div className="rounded-xl border border-dashed border-white/10 p-3 space-y-2">
                <p className="text-xs text-on-surface-variant">{item.lines.length ? 'Another lot or place of it here?' : 'Found it on the shelf? Add it to the count:'}</p>
                <div className="flex gap-2">
                  <select className={`${field} flex-1 !py-2.5`} value={placeId} onChange={e => setPlaceId(e.target.value)} aria-label="Where it was found">
                    <option value="">No location</option>
                    {locations.map(l => <option key={l.id} value={l.id}>{l.code}</option>)}
                  </select>
                  <button type="button" disabled={busy} onClick={() => void addLine()} className="px-4 rounded-xl border border-white/10 bg-surface-container-high font-bold disabled:opacity-40 inline-flex items-center gap-1"><Plus className="w-4 h-4" aria-hidden="true" />Add line</button>
                </div>
              </div>
              <button type="button" onClick={() => { setItem(null); setMsg(null); }} className={`${big} border border-white/10 !py-3`}>Scan another item</button>
            </div>
          )}
        </div>
      </section>

      {camera && (
        <CodeScanner
          title={camera === 'place' ? 'Scan the shelf to count' : 'Scan an item to count'}
          hint={camera === 'place' ? 'Point at the rack or shelf label' : 'Point at the reel or item label'}
          onClose={() => setCamera(null)}
          onCode={(code) => { setCamera(null); void lookUp(code); }}
        />
      )}
    </>
  );
};
