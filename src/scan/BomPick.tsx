import React, { useCallback, useEffect, useState } from 'react';
import { Camera, Check, CheckCircle2, ChevronRight, CircleDot, Layers, Loader2, MapPin, Search, Undo2, X } from 'lucide-react';
import { api, type BomPick, type BomPickLine, type BomPickPlace, type BomPickSummary, type FindResult } from './api';
import { CodeScanner } from './CodeScanner';
import { big, card, field, label } from './ui';

// Scan BOM items: the phone's half of "Book Out Entire BOM". The desktop
// starts a BOM pick; here the person picking sees every open one, opens it,
// and scans each item where the list says it is kept. A line goes green (on
// the desktop too) once what was scanned covers it. An item kept on reels is
// taken a whole reel at a time. The book-out itself is approved on the
// desktop after a final check (server: src/lib/bomPicks.ts).

const same = (a: string | null | undefined, b: string | null | undefined) => String(a ?? '').trim().toUpperCase() === String(b ?? '').trim().toUpperCase();

/** The line a scanned item is picked for: one still to pick first. Null when the item isn't on the BOM. */
export function matchLine(lines: BomPickLine[], partNumbers: string[]): BomPickLine | null {
  const mine = lines.filter(l => partNumbers.some(p => same(p, l.code)));
  return mine.find(l => l.state !== 'done') ?? mine[0] ?? null;
}

/** The place a scan is from: the one a Tracklab reel label names (and its lot), else the only place with stock left. */
export function placeFor(line: BomPickLine, labelPlace?: string | null, labelLot?: string | null): BomPickPlace | null {
  const open = line.places.filter(p => p.available > 0);
  if (labelPlace) {
    const at = open.filter(p => same(p.locationCode, labelPlace));
    const hit = at.find(p => !labelLot || same(p.lot, labelLot)) ?? at[0];
    if (hit) return hit;
  }
  if (labelLot) { const lot = open.find(p => same(p.lot, labelLot)); if (lot) return lot; }
  return open.length === 1 ? open[0] : null;
}

/** What to tell the picker about a line beyond its quantity. */
export function lineNotes(line: BomPickLine, all: BomPickLine[]): string[] {
  const notes: string[] = [];
  if (line.itemsForBomLine > 1) {
    const others = all.filter(l => same(l.bomCode, line.bomCode)).map(l => l.code);
    notes.push(`BOM line ${line.bomCode} needs ${line.itemsForBomLine} items: ${others.join(', ')}`);
  }
  const left = line.need - line.picked;
  const biggest = Math.max(0, ...line.places.map(p => p.available));
  const total = line.places.reduce((s, p) => s + p.available, 0);
  if (left > 0 && total < left) notes.push(`Short: only ${total} left to pick`);
  else if (left > 0 && line.reel && biggest > 0 && biggest < left) notes.push('Needs more than one reel');
  return notes;
}

const tone = (s: BomPickLine['state']) => (s === 'done' ? 'border-green-500/40 bg-green-500/10' : s === 'part' ? 'border-amber-500/40 bg-amber-500/5' : 'border-white/10 bg-surface-container-low');

export const BomPickJob: React.FC<{ onClose: () => void; onError: (e: unknown) => void }> = ({ onClose, onError }) => {
  const [list, setList] = useState<BomPickSummary[] | null>(null);
  const [pick, setPick] = useState<BomPick | null>(null);
  const [camera, setCamera] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  // A scanned item, waiting for its place (and quantity) to be confirmed.
  const [taking, setTaking] = useState<{ line: BomPickLine; place: BomPickPlace | null; qty: string } | null>(null);

  const loadList = useCallback(() => {
    api<{ items: BomPickSummary[] }>('/api/bom-picks?status=OPEN').then(r => setList(r.items || [])).catch(e => { setList([]); onError(e); });
  }, [onError]);
  // Listening for BOMs the desktop sends to be scanned, and for the open one changing there.
  useEffect(() => {
    if (pick) {
      const t = window.setInterval(() => { if (!document.hidden && !taking) api<BomPick>(`/api/bom-picks/${pick.id}`).then(setPick).catch(() => {}); }, 5000);
      return () => window.clearInterval(t);
    }
    loadList();
    const t = window.setInterval(() => { if (!document.hidden) loadList(); }, 5000);
    return () => window.clearInterval(t);
  }, [pick?.id, taking, loadList]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = async (id: number) => {
    setBusy(true); setMsg(null);
    try { setPick(await api<BomPick>(`/api/bom-picks/${id}/open`, { method: 'POST', body: {} })); } catch (e) { onError(e); } finally { setBusy(false); }
  };

  const choose = (line: BomPickLine, labelPlace?: string | null, labelLot?: string | null) => {
    const place = placeFor(line, labelPlace, labelLot);
    setTaking({ line, place, qty: place && !line.reel ? String(Math.min(line.need - line.picked, place.available)) : '' });
    setMsg(null);
  };

  const lookUp = async (code: string) => {
    if (!code.trim() || !pick) return;
    setBusy(true); setMsg(null);
    try {
      const found = await api<FindResult>(`/api/stock-moves/find?code=${encodeURIComponent(code)}`);
      const line = matchLine(pick.lines, found.items.map(i => i.partNumber));
      if (!line) {
        setMsg({ text: found.items.length ? `Wrong part: ${found.items[0].partNumber} is not on this BOM.` : found.location ? `${found.location.code} is a location. Scan the item.` : 'Not found in Tracklab. Check the code.', bad: true });
        return;
      }
      if (line.state === 'done') { setMsg({ text: `${line.code} is already picked (${line.picked} of ${line.need}).` }); return; }
      choose(line, found.label?.place, found.label?.lot);
      setTyped('');
    } catch (e) { onError(e); } finally { setBusy(false); }
  };

  const take = async () => {
    if (!pick || !taking?.place) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api<{ scan: { qty: number; wholeReel: boolean; state: string }; pick: BomPick }>(`/api/bom-picks/${pick.id}/scans`, {
        method: 'POST', body: { lineId: taking.line.id, binId: taking.place.binId, ...(taking.line.reel ? {} : { qty: Number(taking.qty) }) },
      });
      setPick(r.pick);
      const l = r.pick.lines.find(x => x.id === taking.line.id);
      setMsg({ text: `${taking.line.code}: ${r.scan.wholeReel ? `whole reel, ${r.scan.qty}` : r.scan.qty} picked.${l && l.state === 'done' ? ' Line done.' : l ? ` ${l.need - l.picked} more needed.` : ''}${r.pick.complete ? ' Every line is picked: the final check is on the desktop.' : ''}` });
      setTaking(null);
    } catch (e) { onError(e); } finally { setBusy(false); }
  };

  const undo = async (scanId: number) => {
    if (!pick || !window.confirm('Undo this scan? The line goes back to needing it.')) return;
    try { setPick(await api<BomPick>(`/api/bom-picks/${pick.id}/scans/${scanId}/undo`, { method: 'POST', body: {} })); } catch (e) { onError(e); }
  };

  // ---- The list of BOMs waiting to be picked
  if (!pick) {
    return (
      <section className={`${card} overflow-hidden`} aria-label="Scan BOM items">
        <div className="px-4 py-3 border-b border-white/[0.07] bg-primary/10 flex items-center gap-2" data-no-mobile-stack>
          <Layers className="w-4 h-4 text-primary shrink-0" aria-hidden="true" />
          <p className="text-sm font-black flex-1">Scan BOM items</p>
          <button type="button" onClick={onClose} aria-label="Close" className="-m-1 p-1 text-on-surface-variant"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-3 space-y-2">
          {!list && <p className="text-sm text-on-surface-variant flex items-center gap-2 p-2"><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />Loading…</p>}
          {list && !list.length && (
            <p className="text-sm text-on-surface-variant p-2">No BOM is waiting to be picked. On the desktop, press <strong>Book Out Entire BOM</strong> in BOM Manager; it shows up here within a few seconds.</p>
          )}
          {(list || []).map(p => (
            <button key={p.id} type="button" disabled={busy} onClick={() => void open(p.id)} className="w-full text-left rounded-xl border border-white/10 bg-surface-container-low p-3 flex items-center gap-3 active:border-primary" data-no-mobile-stack>
              <span className="min-w-0 flex-1">
                <span className="block font-bold text-primary truncate">{p.projectName || `Project ${p.projectId}`} × {p.buildQty}</span>
                <span className="block text-xs text-on-surface-variant">{p.done} of {p.lines} items picked · started by {p.createdBy || 'someone'}{p.picker ? ` · ${p.picker} scanning` : ''}</span>
              </span>
              <ChevronRight className="w-4 h-4 text-on-surface-variant shrink-0" aria-hidden="true" />
            </button>
          ))}
        </div>
      </section>
    );
  }

  // ---- One BOM being picked
  const todo = pick.lines.filter(l => l.state !== 'done');
  const done = pick.lines.filter(l => l.state === 'done');
  const lineCard = (l: BomPickLine) => {
    const notes = lineNotes(l, pick.lines);
    return (
      <li key={l.id} className={`rounded-xl border p-3 ${tone(l.state)}`}>
        <button type="button" disabled={l.state === 'done' || pick.status !== 'OPEN'} onClick={() => choose(l)} className="w-full text-left" data-no-mobile-stack>
          <span className="flex items-baseline gap-2">
            {l.state === 'done' ? <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0 self-center" aria-label="Picked" /> : <CircleDot className={`w-4 h-4 shrink-0 self-center ${l.state === 'part' ? 'text-amber-400' : 'text-on-surface-variant'}`} aria-hidden="true" />}
            <span className="font-mono font-bold text-sm break-all flex-1">{l.code}</span>
            <span className="font-mono text-sm font-bold whitespace-nowrap">{l.picked}<span className="text-on-surface-variant font-normal">/{l.need}</span></span>
          </span>
          <span className="block text-xs text-on-surface-variant truncate pl-6">{l.item?.name || 'Not an item in Tracklab'}{l.reel ? ' · on reels: whole reel' : ''}{!same(l.bomCode, l.code) ? ` · for ${l.bomCode}` : ''}</span>
          {l.state !== 'done' && (
            <span className="block text-xs pl-6 mt-1">
              {l.places.filter(p => p.available > 0).map(p => (
                <span key={`${p.binId}`} className="inline-flex items-center gap-1 mr-2"><MapPin className="w-3 h-3 text-primary" aria-hidden="true" /><span className="font-mono font-bold">{p.locationCode || 'No location'}</span>{p.lot ? <span className="text-on-surface-variant">lot {p.lot}</span> : null}<span className="text-on-surface-variant">{p.available}</span></span>
              ))}
              {!l.places.some(p => p.available > 0) && <span className="text-error font-bold">None left in stock</span>}
            </span>
          )}
          {notes.map(n => <span key={n} className="block text-[11px] font-bold text-amber-400 pl-6 mt-1">{n}</span>)}
        </button>
        {l.scans.length > 0 && (
          <ul className="mt-2 pl-6 space-y-1">
            {l.scans.map(s => (
              <li key={s.id} className="flex items-center gap-2 text-[11px] text-on-surface-variant" data-no-mobile-stack>
                <Check className="w-3 h-3 text-green-400" aria-hidden="true" />
                <span className="flex-1">{s.wholeReel ? 'Whole reel ' : ''}{s.qty} from {s.locationCode || 'no location'}{s.lot ? ` lot ${s.lot}` : ''} · {s.by}</span>
                {pick.status === 'OPEN' && <button type="button" onClick={() => void undo(s.id)} aria-label={`Undo ${s.qty} of ${l.code}`} className="inline-flex items-center gap-1 font-bold text-error"><Undo2 className="w-3 h-3" />Undo</button>}
              </li>
            ))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <>
      <section className={`${card} overflow-hidden`} aria-label={`Picking ${pick.projectName || 'BOM'}`}>
        <div className="px-4 py-3 border-b border-white/[0.07] bg-primary/10 flex items-center gap-2" data-no-mobile-stack>
          <Layers className="w-4 h-4 text-primary shrink-0" aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-black truncate">{pick.projectName || `Project ${pick.projectId}`} × {pick.buildQty}</p>
            <p className="text-xs text-on-surface-variant">{pick.done} of {pick.total} items picked</p>
          </div>
          <button type="button" onClick={() => { setPick(null); setTaking(null); setMsg(null); }} aria-label="Back to the BOM list" className="-m-1 p-1 text-on-surface-variant"><X className="w-4 h-4" /></button>
        </div>
        <div className="h-1.5 bg-white/10" aria-hidden="true"><div className="h-full bg-green-500 transition-all" style={{ width: `${pick.total ? (pick.done / pick.total) * 100 : 0}%` }} /></div>

        <div className="p-4 space-y-4">
          {msg && <p role={msg.bad ? 'alert' : 'status'} className={`rounded-xl border text-sm font-semibold px-3.5 py-3 ${msg.bad ? 'border-error/25 bg-error/10 text-error' : 'border-green-500/25 bg-green-500/10 text-green-400'}`}>{msg.text}</p>}
          {pick.status !== 'OPEN' && <p role="status" className="rounded-xl border border-white/10 px-3.5 py-3 text-sm font-semibold">{pick.status === 'BOOKED' ? `Booked out on the desktop by ${pick.decidedBy || 'someone'}.` : 'This BOM pick was cancelled on the desktop.'}</p>}
          {pick.status === 'OPEN' && pick.complete && <p className="rounded-xl border border-green-500/25 bg-green-500/10 text-green-400 text-sm font-semibold px-3.5 py-3 flex items-start gap-2"><CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />Every item is picked. The final check and book-out are approved on the desktop.</p>}

          {taking ? (
            <div className="rounded-2xl border border-primary/40 bg-primary/5 p-4 space-y-3" aria-label="Confirm the pick">
              <div className="flex items-start gap-2" data-no-mobile-stack>
                <div className="flex-1 min-w-0">
                  <p className="font-mono font-black text-lg text-primary break-all leading-tight">{taking.line.code}</p>
                  <p className="text-sm">{taking.line.item?.name}</p>
                  <p className="text-xs text-on-surface-variant mt-1">BOM needs {taking.line.need}{taking.line.picked ? `, ${taking.line.picked} picked` : ''}: <strong className="text-on-surface">{taking.line.need - taking.line.picked} more</strong></p>
                </div>
                <button type="button" onClick={() => setTaking(null)} aria-label="Cancel this pick" className="-m-1 p-1 text-on-surface-variant"><X className="w-4 h-4" /></button>
              </div>
              {lineNotes(taking.line, pick.lines).map(n => <p key={n} className="text-xs font-bold text-amber-400">{n}</p>)}
              <div>
                <p className={label}>Taken from</p>
                <div className="space-y-1.5">
                  {taking.line.places.filter(p => p.available > 0).map(p => (
                    <button key={`${p.binId}`} type="button" aria-pressed={taking.place?.binId === p.binId}
                      onClick={() => setTaking(t => t && ({ ...t, place: p, qty: t.line.reel ? '' : String(Math.min(t.line.need - t.line.picked, p.available)) }))}
                      className={`w-full text-left rounded-xl border px-3 py-2.5 flex items-center gap-2 ${taking.place?.binId === p.binId ? 'border-primary bg-primary/10' : 'border-white/10 bg-surface-container-low'}`} data-no-mobile-stack>
                      <MapPin className="w-4 h-4 text-primary shrink-0" aria-hidden="true" />
                      <span className="flex-1 min-w-0"><span className="font-mono font-bold">{p.locationCode || 'No location'}</span>{p.lot ? <span className="text-xs text-on-surface-variant"> · lot {p.lot}</span> : null}</span>
                      <span className="font-mono text-sm">{p.available}</span>
                    </button>
                  ))}
                </div>
              </div>
              {taking.place && (taking.line.reel ? (
                <p className="rounded-xl bg-surface-container-high px-3 py-2.5 text-sm">Whole reel: <strong className="font-mono">{taking.place.available}</strong>{taking.place.available > taking.line.need - taking.line.picked ? <span className="text-xs text-on-surface-variant"> (the BOM needs {taking.line.need - taking.line.picked}; the rest goes with the kit)</span> : null}</p>
              ) : (
                <div>
                  <label className={label} htmlFor="bom-qty">Quantity</label>
                  <input id="bom-qty" className={`${field} font-mono text-2xl font-black text-center`} inputMode="numeric" pattern="[0-9]*" value={taking.qty} onChange={e => setTaking(t => t && ({ ...t, qty: e.target.value.replace(/[^\d]/g, '') }))} />
                  {Number(taking.qty) > taking.line.need - taking.line.picked && <p className="text-xs text-error mt-1">More than the {taking.line.need - taking.line.picked} the BOM still needs.</p>}
                </div>
              ))}
              <button type="button" disabled={busy || !taking.place || (!taking.line.reel && !(Number(taking.qty) > 0))} onClick={() => void take()} className={`${big} bg-green-600 text-white`}>
                {busy ? <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" /> : <Check className="w-5 h-5" aria-hidden="true" />}
                {!taking.place ? 'Choose where it was taken from' : taking.line.reel ? `Pick the whole reel (${taking.place.available})` : `Pick ${taking.qty || 0}`}
              </button>
            </div>
          ) : pick.status === 'OPEN' && !pick.complete && (
            <>
              <button type="button" onClick={() => { setMsg(null); setCamera(true); }} disabled={busy} className="w-full flex flex-col items-center justify-center gap-2 py-6 rounded-2xl border-2 border-dashed border-primary/40 bg-primary/5 active:scale-[0.98] disabled:opacity-40">
                <span className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary text-black shadow-lg"><Camera className="w-7 h-7" aria-hidden="true" /></span>
                <span className="text-base font-black">Scan the next item</span>
                <span className="text-xs text-on-surface-variant">or tap a line below</span>
              </button>
              <form onSubmit={(e) => { e.preventDefault(); void lookUp(typed); }} className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none" aria-hidden="true" />
                  <input className={`${field} !pl-10`} value={typed} onChange={e => setTyped(e.target.value)} placeholder="Stock code" aria-label="Stock code to pick" autoCapitalize="characters" autoCorrect="off" enterKeyHint="search" />
                </div>
                <button type="submit" disabled={busy || !typed.trim()} className="px-5 rounded-xl bg-surface-container-high border border-white/10 font-bold disabled:opacity-40">Find</button>
              </form>
            </>
          )}

          {todo.length > 0 && <div><p className={label}>To pick ({todo.length})</p><ul className="space-y-2">{todo.map(lineCard)}</ul></div>}
          {done.length > 0 && <div><p className={label}>Picked ({done.length})</p><ul className="space-y-2">{done.map(lineCard)}</ul></div>}
        </div>
      </section>

      {camera && (
        <CodeScanner
          title={`Pick for ${pick.projectName || 'the BOM'}`}
          hint="Point at the reel or item label"
          onClose={() => setCamera(false)}
          onCode={(code) => { setCamera(false); void lookUp(code); }}
        />
      )}
    </>
  );
};
