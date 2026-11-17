import React, { useCallback, useEffect, useState } from 'react';
import {
  ArrowDownToLine, ArrowUpFromLine, Camera, Check, CheckCircle2, ChevronDown, Clock, Eye, EyeOff, Loader2,
  LogOut, MapPin, Minus, Package, Plus, ScanLine, Search, X, XCircle,
} from 'lucide-react';
import { api, session, newClientRef, SignedOutError, type FindResult, type FoundItem, type Location, type Move, type ScanUser } from './api';
import { CodeScanner } from './CodeScanner';

// The phone scan page. Sign in with a Tracklab account, choose Book in or
// Book out, scan a label (or type a code), check the item and quantity, and
// send it. The scan goes to the website as Pending (Sales > Scanner), where
// someone approves it; only then does stock change.
//
// Layout notes: widths are written out (max-w-[28rem]) because this
// stylesheet's "md" is a spacing size, not a width. Rows that put text and a
// button side by side carry data-no-mobile-stack: the main app's stylesheet
// otherwise stacks `flex justify-between items-start` rows on phones.

const field = 'w-full rounded-xl border border-white/10 bg-surface-container-low px-3.5 py-3 text-base text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20';
const label = 'block text-[11px] font-bold uppercase tracking-wide text-on-surface-variant mb-1.5';
const card = 'rounded-2xl border border-white/10 bg-surface-container shadow-lg shadow-black/20';
const big = 'w-full flex items-center justify-center gap-2 py-4 rounded-2xl font-black text-base disabled:opacity-40 transition-transform active:scale-[0.98]';

const TONE = {
  IN: { solid: 'bg-green-600 text-white', soft: 'bg-green-500/10 text-green-400 border-green-500/25', text: 'text-green-400', ring: 'border-green-500/40' },
  OUT: { solid: 'bg-amber-500 text-black', soft: 'bg-amber-500/10 text-amber-400 border-amber-500/25', text: 'text-amber-400', ring: 'border-amber-500/40' },
} as const;

/** "2 min ago", "3 h ago", then the date. */
export function ago(v: string | null, now = Date.now()): string {
  const t = new Date(v || '').getTime();
  if (isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleString('en-ZA', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Where an item is, in a line: "REEL-RACK-2 8000 · A1-03 500 · no location 400". */
export function whereLine(item: Pick<FoundItem, 'places' | 'noLocation'>): string {
  const parts = item.places.map(p => `${p.code} ${p.quantity}`);
  if (item.noLocation > 0) parts.push(`no location ${item.noLocation}`);
  return parts.join(' · ') || 'None in stock';
}

const Logo: React.FC<{ size?: number }> = ({ size = 40 }) => (
  <span className="inline-flex items-center justify-center rounded-2xl bg-primary text-black shadow-lg shadow-primary/30 shrink-0" style={{ width: size, height: size }}>
    <ScanLine style={{ width: size * 0.55, height: size * 0.55 }} strokeWidth={2.4} />
  </span>
);

const Page: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="min-h-dvh w-full bg-surface text-on-surface">{children}</div>
);

const SignIn: React.FC<{ onSignedIn: (u: ScanUser) => void }> = ({ onSignedIn }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await api<{ token: string; user: ScanUser }>('/api/mobile/login', { method: 'POST', body: { email: email.trim(), password } });
      session.save(res.token, res.user);
      onSignedIn(res.user);
    } catch (err: any) {
      setError(err.message || 'Could not sign in.');
    } finally { setBusy(false); }
  };
  return (
    <Page>
      <form onSubmit={submit} className="min-h-dvh flex flex-col justify-center gap-4 p-6 w-full max-w-[24rem] mx-auto">
        <div className="text-center mb-4">
          <div className="flex justify-center mb-4"><Logo size={72} /></div>
          <h1 className="text-2xl font-black">Tracklab Scan</h1>
          <p className="text-sm text-on-surface-variant mt-1">Book stock in and out from your phone</p>
        </div>
        <div><label className={label} htmlFor="email">Email</label><input id="email" type="email" autoComplete="username" inputMode="email" autoCapitalize="none" className={field} value={email} onChange={e => setEmail(e.target.value)} required /></div>
        <div>
          <label className={label} htmlFor="password">Password</label>
          <div className="relative">
            <input id="password" type={show ? 'text' : 'password'} autoComplete="current-password" className={`${field} !pr-12`} value={password} onChange={e => setPassword(e.target.value)} required />
            <button type="button" onClick={() => setShow(s => !s)} aria-label={show ? 'Hide' : 'Show'} aria-pressed={show} className="absolute right-1.5 top-1/2 -translate-y-1/2 p-2.5 text-on-surface-variant">
              {show ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
            </button>
          </div>
        </div>
        {error && <p role="alert" className="flex items-start gap-2 rounded-xl border border-error/25 bg-error/10 text-error text-sm font-semibold px-3.5 py-3"><XCircle className="w-4 h-4 mt-0.5 shrink-0" />{error}</p>}
        <button type="submit" disabled={busy} className={`${big} bg-primary text-black mt-1`}>{busy && <Loader2 className="w-5 h-5 animate-spin" />}{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="text-xs text-on-surface-variant text-center leading-relaxed">Use your Tracklab website email and password.<br />Signing in here won't sign you out on your computer.</p>
      </form>
    </Page>
  );
};

type Direction = 'IN' | 'OUT';

const StatusChip: React.FC<{ move: Move }> = ({ move }) => {
  const [cls, Icon, text] = move.status === 'PENDING' ? ['bg-primary/10 text-primary border-primary/30', Clock, 'Waiting for approval']
    : move.status === 'APPROVED' ? ['bg-green-500/10 text-green-400 border-green-500/25', CheckCircle2, 'Approved']
    : ['bg-error/10 text-error border-error/25', XCircle, 'Rejected'];
  return <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold border ${cls}`}><Icon className="w-3 h-3" />{text}</span>;
};

export const ScanApp: React.FC = () => {
  const [user, setUser] = useState<ScanUser | null>(() => (session.token() ? session.user() : null));
  const [direction, setDirection] = useState<Direction>('IN');
  const [camera, setCamera] = useState<null | 'item' | 'place'>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [choices, setChoices] = useState<FoundItem[] | null>(null);
  const [item, setItem] = useState<FoundItem | null>(null);
  const [form, setForm] = useState({ quantity: '', locationId: '', lot: '', dateCode: '', reference: '', note: '' });
  const [fromLabel, setFromLabel] = useState(false);
  const [more, setMore] = useState(false);
  const [clientRef, setClientRef] = useState(newClientRef);
  const [locations, setLocations] = useState<Location[]>([]);
  const [mine, setMine] = useState<Move[]>([]);
  const [, setTick] = useState(0); // re-draws "2 min ago"

  const guard = useCallback((err: any) => {
    if (err instanceof SignedOutError) { setUser(null); return; }
    setError(err?.message || 'Something went wrong.');
  }, []);

  const loadMine = useCallback(() => {
    api<{ items: Move[] }>('/api/stock-moves?mine=1&pageSize=15').then(r => setMine(r.items || [])).catch(e => { if (e instanceof SignedOutError) setUser(null); });
  }, []);

  useEffect(() => {
    if (!user) return;
    // A stored token may have run out (30 idle days) or been ended by a sign-in on another phone.
    api('/api/mobile/me').catch(e => { if (e instanceof SignedOutError) setUser(null); });
    api<{ locations: Location[] }>('/api/stock-locations').then(r => setLocations((r.locations || []).filter(l => l.active))).catch(() => {});
    loadMine();
    const t = window.setInterval(() => { if (!document.hidden) { loadMine(); setTick(n => n + 1); } }, 15_000);
    return () => window.clearInterval(t);
  }, [user, loadMine]);

  // The "sent" message goes after a while; the next scan is what matters.
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 8000);
    return () => window.clearTimeout(t);
  }, [notice]);

  const reset = () => {
    setItem(null); setChoices(null); setTyped(''); setError(null); setFromLabel(false); setMore(false);
    setForm({ quantity: '', locationId: '', lot: '', dateCode: '', reference: '', note: '' });
    setClientRef(newClientRef());
  };

  const choose = (it: FoundItem, found?: FindResult) => {
    setItem(it); setChoices(null);
    // Many items have a location named after their stock code: offer it as the place to put a book-in.
    const own = locations.find(l => l.code.toUpperCase() === it.partNumber.toUpperCase());
    setFromLabel(!!found?.label?.quantity);
    if (direction === 'IN' && (found?.label?.lot || found?.label?.dateCode)) setMore(true); // show what the label filled in
    setForm(f => ({
      ...f,
      locationId: f.locationId || (direction === 'IN' && own ? String(own.id) : ''),
      quantity: found?.label?.quantity ? String(found.label.quantity) : f.quantity,
      lot: found?.label?.lot || f.lot,
      dateCode: found?.label?.dateCode || f.dateCode,
    }));
  };

  const lookUp = async (code: string, forPlace = false) => {
    if (!code.trim()) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const found = await api<FindResult>(`/api/stock-moves/find?code=${encodeURIComponent(code)}`);
      if (forPlace || (item && found.location && !found.items.length)) {
        if (found.location) setForm(f => ({ ...f, locationId: String(found.location!.id) }));
        else setError('That is not a stock location label.');
        return;
      }
      if (found.items.length === 1) choose(found.items[0], found);
      else if (found.items.length > 1) setChoices(found.items);
      else if (found.location) setError(`${found.location.code} is a location. Scan the item first, then its place.`);
      else setError('Not found in Tracklab. Check the code, or add the item on the website first.');
    } catch (err) { guard(err); } finally { setBusy(false); }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!item) return;
    const quantity = Number(form.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) { setError('Enter a whole quantity of 1 or more.'); return; }
    setBusy(true); setError(null);
    try {
      await api<Move>('/api/stock-moves', {
        method: 'POST',
        body: {
          direction, partNumber: item.partNumber, quantity,
          locationId: form.locationId ? Number(form.locationId) : null,
          lot: direction === 'IN' ? form.lot : '', dateCode: direction === 'IN' ? form.dateCode : '',
          reference: form.reference, note: form.note,
          capturedAt: new Date().toISOString(), clientRef,
        },
      });
      setNotice(`Sent for approval: ${direction === 'IN' ? 'book in' : 'book out'} ${quantity} × ${item.partNumber}.`);
      reset();
      loadMine();
    } catch (err) { guard(err); } finally { setBusy(false); }
  };

  const cancel = async (m: Move) => {
    if (!window.confirm(`Cancel this scan (${m.direction === 'IN' ? 'in' : 'out'} ${m.quantity} × ${m.partNumber})?`)) return;
    try {
      const res = await api<{ results: { ok: boolean; error?: string }[] }>('/api/stock-moves/decide', { method: 'POST', body: { ids: [m.id], decision: 'REJECT', reason: 'Cancelled on the phone' } });
      if (res.results[0] && !res.results[0].ok) setError(res.results[0].error || 'Could not cancel it.');
      loadMine();
    } catch (err) { guard(err); }
  };

  const signOut = async () => {
    await api('/api/session/logout', { method: 'POST', body: {} }).catch(() => {});
    session.clear();
    setUser(null); reset(); setMine([]);
  };

  if (!user) return <SignIn onSignedIn={(u) => { setUser(u); setNotice(null); }} />;

  const tone = TONE[direction];
  const dirBtn = (d: Direction, text: string, Icon: typeof ArrowDownToLine) => (
    <button type="button" onClick={() => { setDirection(d); setError(null); }} aria-pressed={direction === d}
      className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl font-black text-base transition-all ${direction === d ? `${TONE[d].solid} shadow-md` : 'text-on-surface-variant'}`}>
      <Icon className="w-4 h-4" aria-hidden="true" />{text}
    </button>
  );
  const place = locations.find(l => String(l.id) === form.locationId);
  const pending = mine.filter(m => m.status === 'PENDING').length;
  const qty = Number(form.quantity) || 0;
  const step = (by: number) => setForm(f => ({ ...f, quantity: String(Math.max(1, (Number(f.quantity) || 0) + by)) }));
  const short = direction === 'OUT' && item && qty > item.stock;

  return (
    <Page>
      <header className="sticky top-0 z-20 border-b border-white/[0.07] bg-surface/90 backdrop-blur" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        <div className="w-full max-w-[28rem] mx-auto px-4 py-3 flex items-center gap-3" data-no-mobile-stack>
          <Logo size={36} />
          <div className="flex-1 min-w-0">
            <h1 className="text-base font-black leading-tight">Tracklab Scan</h1>
            <p className="text-xs text-on-surface-variant truncate">{user.name}</p>
          </div>
          <button onClick={signOut} aria-label="Sign out" className="inline-flex items-center gap-1.5 text-xs font-bold text-on-surface-variant border border-white/10 rounded-xl px-3 py-2 active:bg-surface-container">
            <LogOut className="w-3.5 h-3.5" aria-hidden="true" />Sign out
          </button>
        </div>
      </header>

      <main className="w-full max-w-[28rem] mx-auto p-4 pb-12 space-y-4">
        <div className="flex gap-1 p-1 rounded-2xl bg-surface-container border border-white/10" role="group" aria-label="Book in or out">
          {dirBtn('IN', 'Book in', ArrowDownToLine)}
          {dirBtn('OUT', 'Book out', ArrowUpFromLine)}
        </div>

        {notice && (
          <p role="status" className="flex items-start gap-2 rounded-xl border border-green-500/25 bg-green-500/10 text-green-400 text-sm font-semibold px-3.5 py-3">
            <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" /><span className="flex-1">{notice}</span>
            <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss" className="-m-1 p-1 opacity-70"><X className="w-4 h-4" /></button>
          </p>
        )}
        {error && (
          <p role="alert" className="flex items-start gap-2 rounded-xl border border-error/25 bg-error/10 text-error text-sm font-semibold px-3.5 py-3">
            <XCircle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" /><span className="flex-1">{error}</span>
          </p>
        )}

        {!item && !choices && (
          <section className={`${card} p-4 space-y-4`}>
            <button type="button" onClick={() => { setError(null); setNotice(null); setCamera('item'); }} disabled={busy}
              className={`w-full flex flex-col items-center justify-center gap-2 py-8 rounded-2xl border-2 border-dashed ${tone.ring} ${tone.soft} transition-transform active:scale-[0.98] disabled:opacity-40`}>
              <span className={`inline-flex items-center justify-center w-16 h-16 rounded-2xl ${tone.solid} shadow-lg`}><Camera className="w-8 h-8" aria-hidden="true" /></span>
              <span className="text-lg font-black text-on-surface">Scan a label</span>
              <span className="text-xs text-on-surface-variant">Reel, bag or item label · to book {direction === 'IN' ? 'in' : 'out'}</span>
            </button>
            <div className="flex items-center gap-3 text-[11px] font-bold uppercase tracking-wide text-on-surface-variant"><span className="h-px flex-1 bg-white/10" />or type it<span className="h-px flex-1 bg-white/10" /></div>
            <form onSubmit={(e) => { e.preventDefault(); void lookUp(typed); }} className="flex gap-2">
              <div className="relative flex-1">
                <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none" aria-hidden="true" />
                <input className={`${field} !pl-10`} value={typed} onChange={e => setTyped(e.target.value)} placeholder="Stock code or part number" aria-label="Stock code or part number" autoCapitalize="characters" autoCorrect="off" enterKeyHint="search" />
              </div>
              <button type="submit" disabled={busy || !typed.trim()} className="px-5 rounded-xl bg-surface-container-high border border-white/10 font-bold disabled:opacity-40 inline-flex items-center gap-1.5">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : null}Find
              </button>
            </form>
          </section>
        )}

        {choices && (
          <section className={`${card} p-4 space-y-2`}>
            <p className="text-sm font-black">Which item is it?</p>
            <p className="text-xs text-on-surface-variant -mt-1">That code matches {choices.length} items.</p>
            {choices.map(c => (
              <button key={c.partNumber} type="button" onClick={() => choose(c)} className="w-full text-left rounded-xl border border-white/10 bg-surface-container-low p-3 active:border-primary">
                <span className="font-mono font-bold text-primary">{c.partNumber}</span>
                <span className="block text-sm">{c.name}</span>
                <span className="block text-xs text-on-surface-variant">In stock {c.stock}{c.makerPartNumber ? ` · ${c.makerPartNumber}` : ''}</span>
              </button>
            ))}
            <button type="button" onClick={reset} className={`${big} border border-white/10 !py-3`}>Back</button>
          </section>
        )}

        {item && (
          <form onSubmit={submit} className={`${card} overflow-hidden`}>
            <div className={`px-4 py-3 border-b border-white/[0.07] ${tone.soft} border-x-0 border-t-0 flex items-center gap-2 text-xs font-black uppercase tracking-wide`} data-no-mobile-stack>
              {direction === 'IN' ? <ArrowDownToLine className="w-4 h-4" aria-hidden="true" /> : <ArrowUpFromLine className="w-4 h-4" aria-hidden="true" />}
              Booking {direction === 'IN' ? 'in' : 'out'}
              <button type="button" onClick={reset} aria-label="Start again" className="ml-auto -m-1 p-1 text-on-surface-variant"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 space-y-4">
              <div className="flex gap-3" data-no-mobile-stack>
                <span className="inline-flex items-center justify-center w-11 h-11 rounded-xl bg-surface-container-high border border-white/10 shrink-0"><Package className="w-5 h-5 text-primary" aria-hidden="true" /></span>
                <div className="min-w-0 flex-1">
                  <p className="font-mono font-black text-lg text-primary leading-tight break-all">{item.partNumber}</p>
                  <p className="text-sm font-semibold leading-snug">{item.name}</p>
                  {item.makerPartNumber && <p className="text-xs text-on-surface-variant font-mono break-all">{item.makerPartNumber}</p>}
                </div>
              </div>
              <div className="rounded-xl bg-surface-container-low border border-white/[0.07] p-3">
                <p className="text-sm">In stock: <strong className="font-mono text-base">{item.stock}</strong></p>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {item.places.map(p => (
                    <span key={p.locationId} className="inline-flex items-center gap-1 rounded-lg bg-surface-container-high px-2 py-1 text-[11px]"><MapPin className="w-3 h-3 text-on-surface-variant" aria-hidden="true" /><span className="font-mono font-bold">{p.code}</span><span className="text-on-surface-variant">{p.quantity}</span></span>
                  ))}
                  {item.noLocation > 0 && <span className="inline-flex items-center gap-1 rounded-lg bg-surface-container-high px-2 py-1 text-[11px] text-on-surface-variant">No location <span className="font-mono">{item.noLocation}</span></span>}
                  {!item.places.length && item.noLocation <= 0 && <span className="text-xs text-on-surface-variant">None in stock</span>}
                </div>
              </div>

              <div>
                <label className={label} htmlFor="qty">Quantity to book {direction === 'IN' ? 'in' : 'out'}</label>
                <div className="flex items-stretch gap-2">
                  <button type="button" onClick={() => step(-1)} aria-label="One less" className="w-14 rounded-xl border border-white/10 bg-surface-container-high inline-flex items-center justify-center active:scale-95"><Minus className="w-5 h-5" /></button>
                  <input id="qty" className={`${field} font-mono text-2xl font-black text-center`} inputMode="numeric" pattern="[0-9]*" value={form.quantity} onChange={e => { setFromLabel(false); setForm(f => ({ ...f, quantity: e.target.value.replace(/[^\d]/g, '') })); }} required autoFocus />
                  <button type="button" onClick={() => step(1)} aria-label="One more" className="w-14 rounded-xl border border-white/10 bg-surface-container-high inline-flex items-center justify-center active:scale-95"><Plus className="w-5 h-5" /></button>
                </div>
                {fromLabel && <p className="text-xs text-on-surface-variant mt-1.5 flex items-center gap-1"><Check className="w-3 h-3 text-green-400" aria-hidden="true" />Read from the label. Change it if the reel isn't full.</p>}
                {short && <p className="text-xs text-error mt-1.5">Only {item.stock} in stock: this will be refused.</p>}
              </div>

              <div>
                <label className={label} htmlFor="place">{direction === 'IN' ? 'Put away at' : 'Taken from'} <span className="normal-case font-semibold">(optional)</span></label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <select id="place" className={`${field} appearance-none !pr-9`} value={form.locationId} onChange={e => setForm(f => ({ ...f, locationId: e.target.value }))}>
                      <option value="">{direction === 'IN' ? 'Not put away yet' : 'Oldest stock first'}</option>
                      {(direction === 'OUT' ? locations.filter(l => item.places.some(p => p.locationId === l.id)) : locations).map(l => {
                        const here = item.places.find(p => p.locationId === l.id);
                        return <option key={l.id} value={l.id}>{l.code}{l.name ? ` · ${l.name}` : ''}{here ? ` (${here.quantity} here)` : ''}</option>;
                      })}
                    </select>
                    <ChevronDown className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none" aria-hidden="true" />
                  </div>
                  <button type="button" onClick={() => setCamera('place')} className="px-4 rounded-xl border border-white/10 bg-surface-container-high font-bold whitespace-nowrap inline-flex items-center gap-1.5"><ScanLine className="w-4 h-4" aria-hidden="true" />Scan</button>
                </div>
                {place && <p className="text-xs text-on-surface-variant mt-1.5 flex items-center gap-1"><MapPin className="w-3 h-3" aria-hidden="true" /><span className="font-mono">{place.code}</span>{place.name ? ` · ${place.name}` : ''}</p>}
              </div>

              <div><label className={label} htmlFor="ref">Reference <span className="normal-case font-semibold">(optional)</span></label><input id="ref" className={field} value={form.reference} onChange={e => setForm(f => ({ ...f, reference: e.target.value }))} placeholder="PO, job or order number" autoCapitalize="characters" /></div>

              <div>
                <button type="button" onClick={() => setMore(m => !m)} aria-expanded={more} className="flex items-center gap-1 text-xs font-bold text-on-surface-variant">
                  <ChevronDown className={`w-4 h-4 transition-transform ${more ? 'rotate-180' : ''}`} aria-hidden="true" />{direction === 'IN' ? 'Lot, date code and note' : 'Note'}
                </button>
                {more && (
                  <div className="space-y-3 mt-3">
                    {direction === 'IN' && (
                      <div className="grid grid-cols-2 gap-2">
                        <div><label className={label} htmlFor="lot">Lot</label><input id="lot" className={field} value={form.lot} onChange={e => setForm(f => ({ ...f, lot: e.target.value }))} /></div>
                        <div><label className={label} htmlFor="dc">Date code</label><input id="dc" className={field} value={form.dateCode} onChange={e => setForm(f => ({ ...f, dateCode: e.target.value }))} /></div>
                      </div>
                    )}
                    <div><label className={label} htmlFor="note">Note</label><input id="note" className={field} value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} /></div>
                  </div>
                )}
              </div>

              <button type="submit" disabled={busy} className={`${big} ${tone.solid} shadow-lg`}>
                {busy ? <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" /> : <Check className="w-5 h-5" aria-hidden="true" />}
                {busy ? 'Sending…' : `Send for approval: ${direction === 'IN' ? 'book in' : 'book out'}${qty ? ` ${qty}` : ''}`}
              </button>
              <p className="text-xs text-on-surface-variant text-center -mt-1">Stock changes once someone approves this on the website.</p>
            </div>
          </form>
        )}

        <section className="pt-2">
          <div className="flex items-center gap-2 mb-2.5" data-no-mobile-stack>
            <h2 className="text-sm font-black">My scans</h2>
            {pending > 0 && <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-primary/15 text-primary">{pending} waiting</span>}
          </div>
          {mine.length === 0 && (
            <div className="rounded-2xl border border-dashed border-white/10 p-6 text-center">
              <ScanLine className="w-6 h-6 mx-auto text-on-surface-variant mb-2" aria-hidden="true" />
              <p className="text-sm text-on-surface-variant">Nothing scanned yet. Your scans show here with their approval.</p>
            </div>
          )}
          <ul className="space-y-2">
            {mine.map(m => (
              <li key={m.id} className={`rounded-xl border border-white/10 bg-surface-container p-3 pl-3.5 flex items-center gap-3 border-l-4 ${m.status === 'PENDING' ? 'border-l-primary' : m.status === 'APPROVED' ? 'border-l-green-500' : 'border-l-error'}`} data-no-mobile-stack>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold flex items-baseline gap-2">
                    <span className={`font-mono ${TONE[m.direction].text}`}>{m.direction === 'IN' ? '+' : '−'}{m.quantity}</span>
                    <span className="font-mono truncate">{m.partNumber}</span>
                  </p>
                  <p className="text-xs text-on-surface-variant truncate">{[m.location?.code, m.reference, ago(m.capturedAt || m.createdAt)].filter(Boolean).join(' · ')}</p>
                  <p className="mt-1.5"><StatusChip move={m} /></p>
                  {m.status === 'REJECTED' && m.rejectReason && <p className="text-xs text-error mt-1">{m.rejectReason}</p>}
                  {m.status === 'APPROVED' && m.stockAfter != null && <p className="text-xs text-on-surface-variant mt-1">Stock now {m.stockAfter}{m.decidedBy ? ` · by ${m.decidedBy}` : ''}</p>}
                </div>
                {m.status === 'PENDING' && <button onClick={() => cancel(m)} className="text-xs font-bold text-error border border-error/30 rounded-lg px-3 py-2 shrink-0 active:bg-error/10">Cancel</button>}
              </li>
            ))}
          </ul>
        </section>
      </main>

      {camera && (
        <CodeScanner
          title={camera === 'place' ? 'Scan the place' : `Scan to book ${direction === 'IN' ? 'in' : 'out'}`}
          hint={camera === 'place' ? 'Point at the rack or shelf label' : 'Point at the reel or item label'}
          onClose={() => setCamera(null)}
          onCode={(code) => { const forPlace = camera === 'place'; setCamera(null); void lookUp(code, forPlace); }}
        />
      )}
    </Page>
  );
};
