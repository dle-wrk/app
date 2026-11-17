import React, { useCallback, useEffect, useState } from 'react';
import { api, session, newClientRef, SignedOutError, type FindResult, type FoundItem, type Location, type Move, type ScanUser } from './api';
import { CodeScanner } from './CodeScanner';

// The phone scan page. Sign in with a Tracklab account, choose Book in or
// Book out, scan a label (or type a code), check the item and quantity, and
// send it. The scan goes to the website as Pending (Sales > Scanner), where
// someone approves it; only then does stock change.

const btn = 'w-full py-3.5 rounded-xl font-bold text-base disabled:opacity-40 transition-all active:scale-[0.99]';
const field = 'w-full rounded-xl border border-outline-variant bg-surface-container-low px-3.5 py-3 text-base text-on-surface focus:outline-none focus:border-primary';
const label = 'block text-xs font-bold text-on-surface-variant mb-1';
const card = 'rounded-2xl border border-outline-variant bg-surface-container p-4';

const when = (v: string | null) => {
  const d = new Date(v || '');
  return isNaN(d.getTime()) ? '' : d.toLocaleString('en-ZA', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};

/** Where an item is, in a line: "REEL-RACK-2 8000 · A1-03 500 · no location 400". */
export function whereLine(item: Pick<FoundItem, 'places' | 'noLocation'>): string {
  const parts = item.places.map(p => `${p.code} ${p.quantity}`);
  if (item.noLocation > 0) parts.push(`no location ${item.noLocation}`);
  return parts.join(' · ') || 'None in stock';
}

const SignIn: React.FC<{ onSignedIn: (u: ScanUser) => void }> = ({ onSignedIn }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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
    <form onSubmit={submit} className="min-h-dvh flex flex-col justify-center gap-4 p-6 max-w-md mx-auto">
      <div className="text-center mb-2">
        <img src="/scan-icon-192.png" alt="" className="w-20 h-20 rounded-2xl mx-auto mb-3" />
        <h1 className="text-2xl font-black text-on-surface">Tracklab Scan</h1>
        <p className="text-sm text-on-surface-variant mt-1">Sign in with your Tracklab account</p>
      </div>
      <div><label className={label} htmlFor="email">Email</label><input id="email" type="email" autoComplete="username" inputMode="email" autoCapitalize="none" className={field} value={email} onChange={e => setEmail(e.target.value)} required /></div>
      <div><label className={label} htmlFor="password">Password</label><input id="password" type="password" autoComplete="current-password" className={field} value={password} onChange={e => setPassword(e.target.value)} required /></div>
      {error && <p role="alert" className="text-sm text-error">{error}</p>}
      <button type="submit" disabled={busy} className={`${btn} bg-primary text-white`}>{busy ? 'Signing in…' : 'Sign in'}</button>
      <p className="text-xs text-outline text-center">This sign-in is separate from the website: it won't sign you out on your computer.</p>
    </form>
  );
};

type Direction = 'IN' | 'OUT';

const StatusChip: React.FC<{ move: Move }> = ({ move }) => {
  const cls = move.status === 'PENDING' ? 'bg-primary/10 text-primary border-primary/30' : move.status === 'APPROVED' ? 'bg-green-500/10 text-green-400 border-green-500/20' : 'bg-error/10 text-error border-error/20';
  return <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-bold border ${cls}`}>{move.status === 'PENDING' ? 'Waiting for approval' : move.status === 'APPROVED' ? 'Approved' : 'Rejected'}</span>;
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
  const [clientRef, setClientRef] = useState(newClientRef);
  const [locations, setLocations] = useState<Location[]>([]);
  const [mine, setMine] = useState<Move[]>([]);

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
    const t = window.setInterval(() => { if (!document.hidden) loadMine(); }, 15_000);
    return () => window.clearInterval(t);
  }, [user, loadMine]);

  const reset = () => {
    setItem(null); setChoices(null); setTyped(''); setError(null);
    setForm({ quantity: '', locationId: '', lot: '', dateCode: '', reference: '', note: '' });
    setClientRef(newClientRef());
  };

  const choose = (it: FoundItem, found?: FindResult) => {
    setItem(it); setChoices(null);
    // Many items have a location named after their stock code: offer it as the place to put a book-in.
    const own = locations.find(l => l.code.toUpperCase() === it.partNumber.toUpperCase());
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

  const dirBtn = (d: Direction, text: string) => (
    <button type="button" onClick={() => { setDirection(d); setError(null); }} aria-pressed={direction === d}
      className={`flex-1 py-3 rounded-xl font-black text-base transition-all ${direction === d ? (d === 'IN' ? 'bg-green-600 text-white' : 'bg-amber-500 text-black') : 'text-on-surface-variant'}`}>{text}</button>
  );
  const place = locations.find(l => String(l.id) === form.locationId);
  const pending = mine.filter(m => m.status === 'PENDING').length;

  return (
    <div className="min-h-dvh max-w-md mx-auto p-4 pb-10 space-y-4 text-on-surface" style={{ paddingTop: 'calc(1rem + env(safe-area-inset-top))' }}>
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-black leading-tight">Tracklab Scan</h1>
          <p className="text-xs text-on-surface-variant">{user.name}</p>
        </div>
        <button onClick={signOut} className="text-xs font-bold text-on-surface-variant border border-outline-variant rounded-lg px-3 py-2">Sign out</button>
      </header>

      <div className="flex gap-1 p-1 rounded-2xl bg-surface-container border border-outline-variant" role="group" aria-label="Book in or out">
        {dirBtn('IN', 'Book in')}
        {dirBtn('OUT', 'Book out')}
      </div>

      {notice && <p role="status" className="rounded-xl border border-green-500/20 bg-green-500/10 text-green-400 text-sm font-semibold px-3.5 py-3">{notice}</p>}
      {error && <p role="alert" className="rounded-xl border border-error/20 bg-error/10 text-error text-sm font-semibold px-3.5 py-3">{error}</p>}

      {!item && !choices && (
        <section className={`${card} space-y-3`}>
          <button type="button" onClick={() => { setError(null); setNotice(null); setCamera('item'); }} disabled={busy} className={`${btn} bg-primary text-white`}>Scan a label</button>
          <form onSubmit={(e) => { e.preventDefault(); void lookUp(typed); }} className="flex gap-2">
            <input className={field} value={typed} onChange={e => setTyped(e.target.value)} placeholder="or type a stock code or part number" aria-label="Stock code or part number" autoCapitalize="characters" autoCorrect="off" />
            <button type="submit" disabled={busy || !typed.trim()} className="px-4 rounded-xl border border-outline-variant font-bold disabled:opacity-40">{busy ? '…' : 'Find'}</button>
          </form>
        </section>
      )}

      {choices && (
        <section className={`${card} space-y-2`}>
          <p className="text-sm font-bold">Which item is it?</p>
          {choices.map(c => (
            <button key={c.partNumber} type="button" onClick={() => choose(c)} className="w-full text-left rounded-xl border border-outline-variant p-3 active:bg-surface-container-high">
              <span className="font-mono font-bold text-primary">{c.partNumber}</span>
              <span className="block text-sm">{c.name}</span>
              <span className="block text-xs text-on-surface-variant">In stock {c.stock}{c.makerPartNumber ? ` · ${c.makerPartNumber}` : ''}</span>
            </button>
          ))}
          <button type="button" onClick={reset} className={`${btn} border border-outline-variant`}>Back</button>
        </section>
      )}

      {item && (
        <form onSubmit={submit} className={`${card} space-y-3`}>
          <div>
            <p className="font-mono font-black text-lg text-primary leading-tight">{item.partNumber}</p>
            <p className="text-sm font-semibold">{item.name}</p>
            {item.makerPartNumber && <p className="text-xs text-on-surface-variant font-mono">{item.makerPartNumber}</p>}
            <p className="text-sm mt-2">In stock: <strong className="font-mono">{item.stock}</strong></p>
            <p className="text-xs text-on-surface-variant">{whereLine(item)}</p>
          </div>
          <div>
            <label className={label} htmlFor="qty">Quantity to book {direction === 'IN' ? 'in' : 'out'}</label>
            <input id="qty" className={`${field} font-mono text-xl`} inputMode="numeric" pattern="[0-9]*" value={form.quantity} onChange={e => setForm(f => ({ ...f, quantity: e.target.value.replace(/[^\d]/g, '') }))} required autoFocus />
          </div>
          <div>
            <label className={label} htmlFor="place">{direction === 'IN' ? 'Put away at (optional)' : 'Taken from (optional)'}</label>
            <div className="flex gap-2">
              <select id="place" className={field} value={form.locationId} onChange={e => setForm(f => ({ ...f, locationId: e.target.value }))}>
                <option value="">{direction === 'IN' ? 'Not put away yet' : 'Oldest stock first'}</option>
                {(direction === 'OUT' ? locations.filter(l => item.places.some(p => p.locationId === l.id)) : locations).map(l => {
                  const here = item.places.find(p => p.locationId === l.id);
                  return <option key={l.id} value={l.id}>{l.code}{l.name ? ` · ${l.name}` : ''}{here ? ` (${here.quantity} here)` : ''}</option>;
                })}
              </select>
              <button type="button" onClick={() => setCamera('place')} className="px-4 rounded-xl border border-outline-variant font-bold whitespace-nowrap">Scan</button>
            </div>
            {place && <p className="text-xs text-on-surface-variant mt-1">Place: <span className="font-mono">{place.code}</span></p>}
          </div>
          {direction === 'IN' && (
            <div className="grid grid-cols-2 gap-2">
              <div><label className={label} htmlFor="lot">Lot (optional)</label><input id="lot" className={field} value={form.lot} onChange={e => setForm(f => ({ ...f, lot: e.target.value }))} /></div>
              <div><label className={label} htmlFor="dc">Date code (optional)</label><input id="dc" className={field} value={form.dateCode} onChange={e => setForm(f => ({ ...f, dateCode: e.target.value }))} /></div>
            </div>
          )}
          <div><label className={label} htmlFor="ref">Reference (optional)</label><input id="ref" className={field} value={form.reference} onChange={e => setForm(f => ({ ...f, reference: e.target.value }))} placeholder="PO, job or order number" /></div>
          <div><label className={label} htmlFor="note">Note (optional)</label><input id="note" className={field} value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} /></div>
          <button type="submit" disabled={busy} className={`${btn} ${direction === 'IN' ? 'bg-green-600 text-white' : 'bg-amber-500 text-black'}`}>{busy ? 'Sending…' : `Send for approval: ${direction === 'IN' ? 'book in' : 'book out'}`}</button>
          <button type="button" onClick={reset} disabled={busy} className={`${btn} border border-outline-variant`}>Cancel</button>
          <p className="text-xs text-outline text-center">Stock changes once someone approves this on the website.</p>
        </form>
      )}

      <section>
        <h2 className="text-sm font-black mb-2">My scans{pending ? ` · ${pending} waiting` : ''}</h2>
        {mine.length === 0 && <p className="text-sm text-on-surface-variant">Nothing scanned yet.</p>}
        <ul className="space-y-2">
          {mine.map(m => (
            <li key={m.id} className="rounded-xl border border-outline-variant bg-surface-container p-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-bold"><span className={m.direction === 'IN' ? 'text-green-400' : 'text-amber-500'}>{m.direction === 'IN' ? '+' : '−'}{m.quantity}</span> <span className="font-mono">{m.partNumber}</span></p>
                <p className="text-xs text-on-surface-variant truncate">{[m.location?.code, m.reference, when(m.capturedAt || m.createdAt)].filter(Boolean).join(' · ')}</p>
                <p className="mt-1"><StatusChip move={m} /></p>
                {m.status === 'REJECTED' && m.rejectReason && <p className="text-xs text-error mt-0.5">{m.rejectReason}</p>}
                {m.status === 'APPROVED' && m.stockAfter != null && <p className="text-xs text-on-surface-variant mt-0.5">Stock after: {m.stockAfter}{m.decidedBy ? ` · ${m.decidedBy}` : ''}</p>}
              </div>
              {m.status === 'PENDING' && <button onClick={() => cancel(m)} className="text-xs font-bold text-error border border-error/30 rounded-lg px-2.5 py-1.5 shrink-0">Cancel</button>}
            </li>
          ))}
        </ul>
      </section>

      {camera && (
        <CodeScanner
          hint={camera === 'place' ? 'Scan the rack or shelf label' : 'Scan the reel or item label'}
          onClose={() => setCamera(null)}
          onCode={(code) => { const forPlace = camera === 'place'; setCamera(null); void lookUp(code, forPlace); }}
        />
      )}
    </div>
  );
};
