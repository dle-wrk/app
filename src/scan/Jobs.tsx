import React, { useEffect, useState } from 'react';
import { Boxes, Check, ChevronRight, Clock, Loader2, MapPin, Truck, X } from 'lucide-react';
import { api, stillDue, type KitDetail, type KitSummary, type PickLine, type PoDetail, type PoLine, type PoSummary } from './api';
import { card } from './ui';

// The phone's two guided jobs: receiving a purchase order (each scan books in
// against one of its lines) and picking a saved kit (each scan books out one
// of its pick list's stock codes). Both still go to the website for approval.

const when = (v: string | null) => {
  const t = new Date(v || '').getTime();
  return isNaN(t) ? '' : new Date(t).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short' });
};

/** Choose the purchase order or kit to work on. */
export const JobPicker: React.FC<{ kind: 'po' | 'kit'; onPick: (id: number) => void; onClose: () => void; onError: (e: unknown) => void }> = ({ kind, onPick, onClose, onError }) => {
  const [rows, setRows] = useState<(PoSummary | KitSummary)[] | null>(null);
  const [q, setQ] = useState('');
  useEffect(() => {
    api<{ items: (PoSummary | KitSummary)[] }>(kind === 'po' ? '/api/stock-moves/purchase-orders' : '/api/stock-moves/kits')
      .then(r => setRows(r.items || [])).catch(e => { setRows([]); onError(e); });
  }, [kind, onError]);
  const t = q.trim().toLowerCase();
  const shown = (rows || []).filter(r => !t || JSON.stringify(r).toLowerCase().includes(t));
  return (
    <section className={`${card} overflow-hidden`} aria-label={kind === 'po' ? 'Choose a purchase order' : 'Choose a kit'}>
      <div className="px-4 py-3 border-b border-white/[0.07] flex items-center gap-2" data-no-mobile-stack>
        {kind === 'po' ? <Truck className="w-4 h-4 text-primary" aria-hidden="true" /> : <Boxes className="w-4 h-4 text-primary" aria-hidden="true" />}
        <p className="text-sm font-black flex-1">{kind === 'po' ? 'Receive which order?' : 'Pick which kit?'}</p>
        <button type="button" onClick={onClose} aria-label="Close" className="-m-1 p-1 text-on-surface-variant"><X className="w-4 h-4" /></button>
      </div>
      <div className="p-3 space-y-2">
        <input className="w-full rounded-xl border border-white/10 bg-surface-container-low px-3.5 py-2.5 text-base text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:border-primary"
          value={q} onChange={e => setQ(e.target.value)} placeholder={kind === 'po' ? 'PO number or supplier' : 'Kit or project'} aria-label="Search" autoCapitalize="characters" autoCorrect="off" />
        {!rows && <p className="text-sm text-on-surface-variant flex items-center gap-2 p-2"><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />Loading…</p>}
        {rows && !shown.length && <p className="text-sm text-on-surface-variant p-2">{rows.length ? 'Nothing matches.' : kind === 'po' ? 'No purchase orders are waiting to be received.' : 'No saved kits yet. Kits are saved in Kit Booking on the website.'}</p>}
        <ul className="space-y-1.5 max-h-[60dvh] overflow-y-auto">
          {shown.map(r => (
            <li key={r.id}>
              <button type="button" onClick={() => onPick(r.id)} className="w-full text-left rounded-xl border border-white/10 bg-surface-container-low p-3 flex items-center gap-3 active:border-primary" data-no-mobile-stack>
                <span className="min-w-0 flex-1">
                  {'number' in r ? (
                    <>
                      <span className="block font-mono font-bold text-primary">{r.number} <span className="text-[11px] font-sans font-bold text-on-surface-variant">{r.status === 'PARTIAL' ? 'part received' : r.status.toLowerCase()}</span></span>
                      <span className="block text-sm truncate">{r.supplier || 'No supplier'}</span>
                      <span className="block text-xs text-on-surface-variant">{r.lines} line{r.lines === 1 ? '' : 's'} · {r.outstanding} still due{r.expectedDate ? ` · expected ${when(r.expectedDate)}` : ''}</span>
                    </>
                  ) : (
                    <>
                      <span className="block font-bold text-primary truncate">{r.name}</span>
                      <span className="block text-xs text-on-surface-variant">{r.project ? `${r.project} · ` : ''}{r.buildQty} board{r.buildQty === 1 ? '' : 's'} · {r.lines} BOM line{r.lines === 1 ? '' : 's'}</span>
                    </>
                  )}
                </span>
                <ChevronRight className="w-4 h-4 text-on-surface-variant shrink-0" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
};

const Progress: React.FC<{ total: number; done: number; waiting: number }> = ({ total, done, waiting }) => {
  const pct = (n: number) => `${total > 0 ? Math.min(100, (n / total) * 100) : 0}%`;
  return (
    <span className="block h-1.5 rounded-full bg-white/10 overflow-hidden mt-1.5" aria-hidden="true">
      <span className="flex h-full">
        <span className="bg-green-500" style={{ width: pct(done) }} />
        <span className="bg-primary/70" style={{ width: pct(Math.min(waiting, Math.max(0, total - done))) }} />
      </span>
    </span>
  );
};

/** The purchase order being received: its lines, with what's in and what's waiting for approval. */
export const PoCard: React.FC<{ po: PoDetail; active: number | null; onLine: (l: PoLine) => void; onClose: () => void }> = ({ po, active, onLine, onClose }) => {
  const [open, setOpen] = useState(true);
  const due = po.lines.reduce((s, l) => s + stillDue(l.quantity, l.received, l.waiting), 0);
  return (
    <section className={`${card} overflow-hidden`} aria-label={`Receiving ${po.number}`}>
      <div className="px-4 py-3 border-b border-white/[0.07] bg-green-500/10 flex items-center gap-2" data-no-mobile-stack>
        <Truck className="w-4 h-4 text-green-400 shrink-0" aria-hidden="true" />
        <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} className="flex-1 min-w-0 text-left">
          <span className="block text-sm font-black">Receiving <span className="font-mono">{po.number}</span></span>
          <span className="block text-xs text-on-surface-variant truncate">{po.supplier || 'No supplier'} · {due ? `${due} still due` : 'everything is in or waiting'}</span>
        </button>
        <button type="button" onClick={onClose} aria-label="Stop receiving this order" className="-m-1 p-1 text-on-surface-variant"><X className="w-4 h-4" /></button>
      </div>
      {open && (
        <ul className="divide-y divide-white/[0.06]">
          {po.lines.map(l => {
            const left = stillDue(l.quantity, l.received, l.waiting);
            const full = l.received >= l.quantity;
            return (
              <li key={l.id}>
                <button type="button" disabled={!l.inTracklab} onClick={() => onLine(l)} aria-pressed={active === l.id}
                  className={`w-full text-left px-4 py-2.5 flex items-center gap-3 disabled:opacity-50 ${active === l.id ? 'bg-primary/10' : 'active:bg-white/5'}`} data-no-mobile-stack>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2"><span className="font-mono font-bold text-sm truncate">{l.partNumber || '—'}</span>{full && <Check className="w-3.5 h-3.5 text-green-400 shrink-0" aria-label="All received" />}</span>
                    <span className="block text-xs text-on-surface-variant truncate">{l.inTracklab ? (l.name || l.description) : `${l.description || ''} · not an item in Tracklab`}</span>
                    <Progress total={l.quantity} done={l.received} waiting={l.waiting} />
                  </span>
                  <span className="text-right shrink-0">
                    <span className="block font-mono text-sm font-bold">{l.received}<span className="text-on-surface-variant font-normal">/{l.quantity}</span></span>
                    <span className="block text-[11px] text-on-surface-variant">{l.waiting ? `${l.waiting} waiting` : left ? `${left} due` : ''}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};

/** The kit being picked: what to take of each stock code, where it is, and what's been sent. */
export const KitCard: React.FC<{ kit: KitDetail; active: string | null; onLine: (l: PickLine) => void; onClose: () => void }> = ({ kit, active, onLine, onClose }) => {
  const [open, setOpen] = useState(true);
  const left = kit.lines.filter(l => stillDue(l.need, l.bookedOut, l.waiting) > 0).length;
  return (
    <section className={`${card} overflow-hidden`} aria-label={`Picking kit ${kit.name}`}>
      <div className="px-4 py-3 border-b border-white/[0.07] bg-amber-500/10 flex items-center gap-2" data-no-mobile-stack>
        <Boxes className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
        <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} className="flex-1 min-w-0 text-left">
          <span className="block text-sm font-black truncate">Picking kit {kit.name}</span>
          <span className="block text-xs text-on-surface-variant">{kit.buildQty} board{kit.buildQty === 1 ? '' : 's'} · {left ? `${left} of ${kit.lines.length} codes left to pick` : 'everything is picked'}</span>
        </button>
        <button type="button" onClick={onClose} aria-label="Stop picking this kit" className="-m-1 p-1 text-on-surface-variant"><X className="w-4 h-4" /></button>
      </div>
      {open && (
        <ul className="divide-y divide-white/[0.06] max-h-[45dvh] overflow-y-auto">
          {kit.lines.map(l => {
            const due = stillDue(l.need, l.bookedOut, l.waiting);
            const short = l.item ? l.item.stock < due : true;
            return (
              <li key={l.code}>
                <button type="button" disabled={!l.item} onClick={() => onLine(l)} aria-pressed={active === l.code}
                  className={`w-full text-left px-4 py-2.5 flex items-center gap-3 disabled:opacity-50 ${active === l.code ? 'bg-primary/10' : 'active:bg-white/5'}`} data-no-mobile-stack>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2"><span className="font-mono font-bold text-sm truncate">{l.code}</span>{l.bookedOut >= l.need && <Check className="w-3.5 h-3.5 text-green-400 shrink-0" aria-label="Picked" />}</span>
                    <span className="block text-xs text-on-surface-variant truncate">
                      {l.item ? (l.item.places.length ? <><MapPin className="w-3 h-3 inline -mt-0.5" aria-hidden="true" /> {l.item.places.map(p => `${p.code} ${p.quantity}`).join(' · ')}{l.item.noLocation > 0 ? ` · no location ${l.item.noLocation}` : ''}</> : l.item.stock > 0 ? `No location ${l.item.stock}` : 'None in stock') : 'Not an item in Tracklab'}
                    </span>
                    {due > 0 && short && <span className="block text-[11px] font-bold text-error">Only {l.item?.stock ?? 0} in stock</span>}
                    <Progress total={l.need} done={l.bookedOut} waiting={l.waiting} />
                  </span>
                  <span className="text-right shrink-0">
                    <span className="block font-mono text-sm font-bold">{due || (l.bookedOut >= l.need ? <Check className="w-4 h-4 inline text-green-400" aria-hidden="true" /> : <Clock className="w-4 h-4 inline text-primary" aria-hidden="true" />)}</span>
                    <span className="block text-[11px] text-on-surface-variant">{due ? `of ${l.need}` : l.bookedOut >= l.need ? `${l.need} booked out` : `${l.waiting} waiting`}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};
