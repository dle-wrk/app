import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine, ArrowUpFromLine, Barcode, Boxes, Camera, Check, CheckCircle2, ChevronDown, ClipboardList, Clock, Eye, EyeOff, Link2, Loader2,
  ArrowUp, Layers, LogOut, MapPin, Minus, Package, PackagePlus, Plus, ScanLine, Search, Truck, X, XCircle,
} from 'lucide-react';
import {
  api, session, newClientRef, stillDue, SignedOutError,
  type BomPickSummary, type FindResult, type FoundItem, type KitDetail, type Location, type Move, type NewItem, type PickLine, type PoDetail, type PoLine, type ScanUser,
} from './api';
import { CodeScanner } from './CodeScanner';
import { JobPicker, KitCard, PoCard } from './Jobs';
import { CountJob } from './CountJob';
import { BomPickJob } from './BomPick';
import { TONE, big, card, field, label } from './ui';

// The phone scan page. Sign in with a Tracklab account, choose Book in or
// Book out, scan a label (or type a code), check the item and quantity, and
// send it. The scan goes to the website as Pending (Sales > Scanner), where
// someone approves it; only then does stock change.
//
// Three guided jobs use the same booking: Receive a PO (each scan books in
// against one of its lines, and a label for something not on the order is
// refused), Pick a kit (each scan books out a code from the kit's pick list;
// a wrong part is refused before anything is sent), and Count stock
// (./CountJob: scan an item, correct the quantity at each place; saved at once, no approval).
//
// Layout notes: widths are written out (max-w-[28rem]) because this
// stylesheet's "md" is a spacing size, not a width. Rows that put text and a
// button side by side carry data-no-mobile-stack: the main app's stylesheet
// otherwise stacks `flex justify-between items-start` rows on phones.


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

/** Scans loaded per page of My scans (more load as the list is scrolled). */
export const SCANS_PAGE = 20;
const scannedAt = (m: Move) => new Date(m.capturedAt || m.createdAt).getTime() || 0;
/**
 * My scans after a page arrives: the new rows replace the ones with the same
 * id (their status may have changed), nothing is listed twice, newest first
 * (as the server sorts them).
 */
export function mergeScans(prev: Move[], page: Move[]): Move[] {
  const byId = new Map(prev.map(m => [m.id, m]));
  for (const m of page) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => scannedAt(b) - scannedAt(a) || b.id - a.id);
}
const same = (a: string | null | undefined, b: string | null | undefined) => String(a ?? '').trim().toUpperCase() === String(b ?? '').trim().toUpperCase();

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
  // My scans: the newest page is re-read every 15 s; older pages load as the list is scrolled.
  const [mineTotal, setMineTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showTop, setShowTop] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const [, setTick] = useState(0); // re-draws "2 min ago"
  // A book-in label that isn't in Tracklab: add it as a new item, or link it to an existing one.
  const [unknown, setUnknown] = useState<{ code: string; barcodes: string[]; label: FindResult['label'] } | null>(null);
  const [mode, setMode] = useState<null | 'new' | 'link'>(null);
  const [draft, setDraft] = useState({ partNumber: '', name: '', makerPartNumber: '', description: '' });
  const [newItem, setNewItem] = useState<NewItem | null>(null);
  // A guided job: receiving a purchase order, picking a kit, or counting.
  const [picking, setPicking] = useState<null | 'po' | 'kit'>(null);
  const [po, setPo] = useState<PoDetail | null>(null);
  const [poLine, setPoLine] = useState<PoLine | null>(null);
  const [kit, setKit] = useState<KitDetail | null>(null);
  const [pick, setPick] = useState<PickLine | null>(null);
  const [counting, setCounting] = useState(false);
  const [bomPicking, setBomPicking] = useState(false);
  // BOMs the desktop has sent to be scanned: announced on the home screen.
  const [bomsWaiting, setBomsWaiting] = useState<BomPickSummary[]>([]);

  const guard = useCallback((err: any) => {
    if (err instanceof SignedOutError) { setUser(null); return; }
    setError(err?.message || 'Something went wrong.');
  }, []);

  const loadMine = useCallback(() => {
    api<{ items: Move[]; total: number }>(`/api/stock-moves?mine=1&pageSize=${SCANS_PAGE}`)
      .then(r => { setMine(prev => mergeScans(prev, r.items || [])); setMineTotal(r.total || 0); })
      .catch(e => { if (e instanceof SignedOutError) setUser(null); });
  }, []);
  // The next page of older scans. New scans arriving meanwhile only shift rows already loaded onto
  // the next page, and those are merged by id, so nothing is skipped or listed twice.
  const loadMore = useCallback(async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const page = Math.floor(mine.length / SCANS_PAGE) + 1;
      const r = await api<{ items: Move[]; total: number }>(`/api/stock-moves?mine=1&pageSize=${SCANS_PAGE}&page=${page}`);
      setMine(prev => mergeScans(prev, r.items || []));
      setMineTotal(r.total || 0);
    } catch (e) { if (e instanceof SignedOutError) setUser(null); } finally { setLoadingMore(false); }
  }, [loadingMore, mine.length]);
  const hasMore = mine.length < mineTotal;
  // Older scans load when the end of the list comes into view.
  useEffect(() => {
    const el = moreRef.current;
    if (!el || !hasMore || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((es) => { if (es.some(e => e.isIntersecting)) void loadMore(); }, { rootMargin: '300px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadMore]);
  useEffect(() => {
    const on = () => setShowTop(window.scrollY > 900);
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);

  useEffect(() => {
    if (!user) return;
    // A stored token may have run out (30 idle days) or been ended by a sign-in on another phone.
    api('/api/mobile/me').catch(e => { if (e instanceof SignedOutError) setUser(null); });
    api<{ locations: Location[] }>('/api/stock-locations').then(r => setLocations((r.locations || []).filter(l => l.active))).catch(() => {});
    const loadBoms = () => api<{ items: BomPickSummary[] }>('/api/bom-picks?status=OPEN').then(r => setBomsWaiting(r.items || [])).catch(() => {});
    loadMine(); loadBoms();
    const t = window.setInterval(() => { if (!document.hidden) { loadMine(); loadBoms(); setTick(n => n + 1); } }, 15_000);
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
    setUnknown(null); setMode(null); setNewItem(null); setDraft({ partNumber: '', name: '', makerPartNumber: '', description: '' });
    setPoLine(null); setPick(null);
    setForm({ quantity: '', locationId: '', lot: '', dateCode: '', reference: '', note: '' });
    setClientRef(newClientRef());
  };

  /** due: what is still to receive or pick on the job's line, the quantity to start from when the label doesn't say. */
  const choose = (it: FoundItem, found?: FindResult, due?: number) => {
    setItem(it); setChoices(null);
    // Many items have a location named after their stock code: offer it as the place to put a book-in.
    const own = locations.find(l => l.code.toUpperCase() === it.partNumber.toUpperCase());
    // When linking an unknown label, what it said (quantity, lot) comes from that first scan.
    const label = found?.label ?? unknown?.label ?? null;
    // Picking a kit takes what the kit needs, not the whole reel the label describes.
    const labelQty = kit ? null : label?.quantity ?? null;
    // A Tracklab reel label says where the reel was put away.
    const at = label?.place ? locations.find(l => same(l.code, label.place)) : undefined;
    const atOk = !!at && (direction === 'IN' || it.places.some(p => p.locationId === at.id));
    setFromLabel(!!labelQty);
    if (direction === 'IN' && (label?.lot || label?.dateCode)) setMore(true); // show what the label filled in
    setForm(f => ({
      ...f,
      locationId: f.locationId || (atOk ? String(at!.id) : direction === 'IN' && own ? String(own.id) : ''),
      quantity: labelQty ? String(labelQty) : due ? String(due) : f.quantity,
      lot: label?.lot || f.lot,
      dateCode: label?.dateCode || f.dateCode,
    }));
  };

  const openJob = async (kind: 'po' | 'kit', id: number) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      if (kind === 'po') { setPo(await api<PoDetail>(`/api/stock-moves/purchase-orders/${id}`)); setKit(null); setDirection('IN'); }
      else { setKit(await api<KitDetail>(`/api/stock-moves/kits/${id}`)); setPo(null); setDirection('OUT'); }
      reset(); setPicking(null);
    } catch (err) { guard(err); } finally { setBusy(false); }
  };
  const refreshJob = async () => {
    try {
      if (po) setPo(await api<PoDetail>(`/api/stock-moves/purchase-orders/${po.id}`));
      if (kit) setKit(await api<KitDetail>(`/api/stock-moves/kits/${kit.id}`));
    } catch (err) { guard(err); }
  };
  const closeJob = () => { setPo(null); setKit(null); reset(); };

  /** A line of the order being received: its item, with what's still due as the quantity. */
  const selectPoLine = async (line: PoLine, found?: FindResult) => {
    setBusy(true); setError(null);
    try {
      let it = found?.items.find(i => same(i.partNumber, line.partNumber));
      if (!it) it = (await api<FindResult>(`/api/stock-moves/find?code=${encodeURIComponent(line.partNumber || '')}`)).items.find(i => same(i.partNumber, line.partNumber));
      if (!it) { setError(`${line.partNumber} is not an item in Tracklab.`); return; }
      setPoLine(line);
      choose(it, found, stillDue(line.quantity, line.received, line.waiting) || undefined);
    } catch (err) { guard(err); } finally { setBusy(false); }
  };
  /** A code on the kit's pick list: its item, with what's still to pick as the quantity. */
  const selectPick = (line: PickLine, found?: FindResult) => {
    if (!line.item) return;
    setPick(line); setError(null);
    choose(line.item, found, stillDue(line.need, line.bookedOut, line.waiting) || undefined);
  };

  const startNew = () => {
    setMode('new'); setError(null);
    // A supplier label's first part number is the maker's: offer it for the new item.
    setDraft(d => ({ ...d, makerPartNumber: d.makerPartNumber || (unknown?.label ? unknown.label.partNumbers[0] || '' : '') }));
  };

  // The new item's details are checked (stock code free), then it is booked in like any other.
  const continueNew = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = draft.partNumber.trim().toUpperCase().replace(/\s+/g, '-');
    if (!/^[A-Z0-9][A-Z0-9._/-]{1,59}$/.test(code)) { setError('Give it a stock code: 2 to 60 letters, digits, dashes, dots or slashes.'); return; }
    if (!draft.name.trim()) { setError('Give the new item a name.'); return; }
    setBusy(true); setError(null);
    try {
      const found = await api<FindResult>(`/api/stock-moves/find?code=${encodeURIComponent(code)}`);
      const same = found.matchedBy === 'stock code' ? found.items[0] : null;
      if (same) { setError(`${same.partNumber} is already an item (${same.name}). Choose another stock code, or link the label to it instead.`); return; }
      const ni: NewItem = { partNumber: code, name: draft.name.trim(), makerPartNumber: draft.makerPartNumber.trim() || null, description: draft.description.trim() || null };
      setNewItem(ni);
      choose({ partNumber: code, name: ni.name, description: ni.description, makerPartNumber: ni.makerPartNumber, packaging: null, status: 'ACTIVE', stock: 0, places: [], noLocation: 0 });
    } catch (err) { guard(err); } finally { setBusy(false); }
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
      if (unknown) {
        // Looking for the existing item to link the unknown label to.
        if (found.items.length === 1) choose(found.items[0]);
        else if (found.items.length > 1) setChoices(found.items);
        else setError('No item matches that. Try another code or name, or add it as a new item.');
        return;
      }
      if (po) {
        // Receiving an order: the label must be for one of its lines (the one still due first).
        const lines = po.lines.filter(l => l.inTracklab && found.items.some(i => same(i.partNumber, l.partNumber)));
        if (lines.length) { await selectPoLine(lines.find(l => stillDue(l.quantity, l.received, l.waiting) > 0) ?? lines[0], found); return; }
        if (found.items.length) { setError(`${found.items.map(i => i.partNumber).slice(0, 3).join(', ')} ${found.items.length === 1 ? 'is' : 'are'} not on ${po.number}. Check the label, or close the order to book it in on its own.`); return; }
        if (found.location) { setError(`${found.location.code} is a location. Scan the item first, then its place.`); return; }
        // A supplier label Tracklab doesn't know: say which line it is, and the label is remembered for next time.
        if (found.barcodes?.length) { setUnknown({ code, barcodes: found.barcodes, label: found.label }); setMode('link'); setTyped(''); return; }
        setError('Not found in Tracklab. Check the code.');
        return;
      }
      if (kit) {
        const line = kit.lines.find(l => l.item && found.items.some(i => same(i.partNumber, l.code)));
        if (line) { selectPick(line, found); return; }
        if (found.items.length) { setError(`Wrong part: ${found.items[0].partNumber} is not on the pick list for kit ${kit.name}.`); return; }
        setError(found.location ? `${found.location.code} is a location. Scan the reel first.` : 'Not found in Tracklab. Check the code.');
        return;
      }
      if (found.items.length === 1) choose(found.items[0], found);
      else if (found.items.length > 1) setChoices(found.items);
      else if (found.location) setError(`${found.location.code} is a location. Scan the item first, then its place.`);
      else if (direction === 'IN' && found.barcodes?.length) { setUnknown({ code, barcodes: found.barcodes, label: found.label }); setTyped(''); }
      else setError(direction === 'OUT' ? 'Not found in Tracklab, so there is nothing to book out. Check the code.' : 'Not found in Tracklab. Check the code.');
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
          // An unknown label: the item to create, or the label to remember on the chosen item.
          ...(newItem ? { newItem } : {}),
          ...(unknown ? { code: unknown.code, saveBarcode: !newItem } : {}),
          ...(po && poLine ? { poItemId: poLine.id } : {}),
          ...(kit && pick ? { kitId: kit.id } : {}),
        },
      });
      const job = po ? ` on ${po.number}` : kit ? ` for kit ${kit.name}` : '';
      setNotice(`Sent for approval: ${direction === 'IN' ? 'book in' : 'book out'} ${quantity} × ${item.partNumber}${job}${newItem ? ' (new item)' : unknown ? ' (barcode linked)' : ''}.`);
      reset();
      loadMine();
      void refreshJob();
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
    setUser(null); reset(); setMine([]); setMineTotal(0); setPo(null); setKit(null); setCounting(false); setPicking(null); setBomPicking(false);
  };

  if (!user) return <SignIn onSignedIn={(u) => { setUser(u); setNotice(null); }} />;

  const tone = TONE[direction];
  const dirBtn = (d: Direction, text: string, Icon: typeof ArrowDownToLine) => (
    <button type="button" onClick={() => { if (d !== direction && (unknown || newItem)) reset(); setDirection(d); setError(null); }} aria-pressed={direction === d}
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
        {bomPicking ? (
          <BomPickJob onClose={() => setBomPicking(false)} onError={guard} />
        ) : counting ? (
          <CountJob locations={locations} onClose={() => setCounting(false)} onError={guard} />
        ) : po ? (
          <PoCard po={po} active={poLine?.id ?? null} onLine={(l) => { reset(); void selectPoLine(l); }} onClose={closeJob} />
        ) : kit ? (
          <KitCard kit={kit} active={pick?.code ?? null} onLine={(l) => { reset(); selectPick(l); }} onClose={closeJob} />
        ) : (
          <>
            <div className="flex gap-1 p-1 rounded-2xl bg-surface-container border border-white/10" role="group" aria-label="Book in or out">
              {dirBtn('IN', 'Book in', ArrowDownToLine)}
              {dirBtn('OUT', 'Book out', ArrowUpFromLine)}
            </div>
            {!item && !unknown && !choices && !picking && bomsWaiting.length > 0 && (
              <button type="button" onClick={() => { setError(null); setNotice(null); setBomPicking(true); }} className="w-full text-left rounded-2xl border-2 border-primary bg-primary/10 p-3.5 flex items-center gap-3 active:scale-[0.98]" data-no-mobile-stack>
                <span className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-primary text-black shrink-0"><Layers className="w-5 h-5" aria-hidden="true" /></span>
                <span className="flex-1 min-w-0">
                  <span className="block font-black">{bomsWaiting.length === 1 ? 'A BOM is waiting to be scanned' : `${bomsWaiting.length} BOMs are waiting to be scanned`}</span>
                  <span className="block text-xs text-on-surface-variant truncate">{bomsWaiting.map(b => `${b.projectName || `Project ${b.projectId}`} × ${b.buildQty} (${b.done}/${b.lines})`).join(' · ')}</span>
                </span>
                <span className="text-xs font-black text-primary whitespace-nowrap">SCAN BOM ITEMS</span>
              </button>
            )}
            {!item && !unknown && !choices && !picking && (
              <div className="grid grid-cols-2 gap-2" role="group" aria-label="Other jobs">
                {([['bom', 'Scan BOM items', Layers], ['po', 'Receive a PO', Truck], ['kit', 'Pick a kit', Boxes], ['count', 'Count stock', ClipboardList]] as const).map(([k, text, Icon]) => (
                  <button key={k} type="button" onClick={() => { setError(null); setNotice(null); if (k === 'count') setCounting(true); else if (k === 'bom') setBomPicking(true); else setPicking(k); }}
                    className="flex flex-col items-center gap-1 rounded-xl border border-white/10 bg-surface-container py-2.5 text-xs font-bold text-on-surface-variant active:border-primary active:text-on-surface">
                    <Icon className="w-4 h-4 text-primary" aria-hidden="true" />{text}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        {picking && !counting && !bomPicking && <JobPicker kind={picking} onPick={(id) => void openJob(picking, id)} onClose={() => setPicking(null)} onError={guard} />}

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

        {!counting && !picking && !bomPicking && (<>
        {unknown && !item && !choices && (
          <section className={`${card} overflow-hidden`} aria-label="Not in Tracklab">
            <div className="px-4 py-3 border-b border-white/[0.07] bg-primary/10 flex items-center gap-2" data-no-mobile-stack>
              <PackagePlus className="w-4 h-4 text-primary" aria-hidden="true" />
              <p className="text-sm font-black flex-1">Not in Tracklab yet</p>
              <button type="button" onClick={reset} aria-label="Start again" className="-m-1 p-1 text-on-surface-variant"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 space-y-4">
              <div>
                <p className={label}>Scanned</p>
                <div className="flex flex-wrap gap-1.5">
                  {unknown.barcodes.map(b => <span key={b} className="inline-flex items-center gap-1 rounded-lg bg-surface-container-high px-2 py-1 font-mono text-xs font-bold break-all"><Barcode className="w-3.5 h-3.5 text-on-surface-variant shrink-0" aria-hidden="true" />{b}</span>)}
                  {unknown.label?.quantity ? <span className="inline-flex items-center rounded-lg bg-surface-container-high px-2 py-1 text-xs text-on-surface-variant">Qty {unknown.label.quantity}</span> : null}
                </div>
              </div>

              {mode === 'link' && po && (
                <div className="space-y-2">
                  <p className="text-sm">Which line of <span className="font-mono font-bold">{po.number}</span> is it? The label is remembered on that item, so it's found next time.</p>
                  {po.lines.filter(l => l.inTracklab).map(l => (
                    <button key={l.id} type="button" onClick={() => void selectPoLine(l)} className="w-full text-left rounded-xl border border-white/10 bg-surface-container-low p-3 active:border-primary">
                      <span className="font-mono font-bold text-primary">{l.partNumber}</span>
                      <span className="block text-sm">{l.name || l.description}</span>
                      <span className="block text-xs text-on-surface-variant">{l.received} of {l.quantity} received{l.waiting ? ` · ${l.waiting} waiting` : ''}</span>
                    </button>
                  ))}
                  <button type="button" onClick={reset} className="w-full text-sm font-bold text-on-surface-variant py-2">It isn't on this order</button>
                </div>
              )}

              {!mode && (
                <>
                  <button type="button" onClick={startNew} className="w-full text-left rounded-2xl border border-white/10 bg-surface-container-low p-4 flex items-center gap-3 active:border-primary" data-no-mobile-stack>
                    <span className="inline-flex items-center justify-center w-11 h-11 rounded-xl bg-green-600 text-white shrink-0"><Plus className="w-5 h-5" aria-hidden="true" /></span>
                    <span className="flex-1"><span className="block font-black">Add as a new item</span><span className="block text-xs text-on-surface-variant">Give it a stock code and name, then book it in</span></span>
                  </button>
                  <button type="button" onClick={() => { setMode('link'); setError(null); }} className="w-full text-left rounded-2xl border border-white/10 bg-surface-container-low p-4 flex items-center gap-3 active:border-primary" data-no-mobile-stack>
                    <span className="inline-flex items-center justify-center w-11 h-11 rounded-xl bg-surface-container-high border border-white/10 shrink-0"><Link2 className="w-5 h-5 text-primary" aria-hidden="true" /></span>
                    <span className="flex-1"><span className="block font-black">Link to an existing item</span><span className="block text-xs text-on-surface-variant">It's in Tracklab under another code: this label will find it next time</span></span>
                  </button>
                  <p className="text-xs text-on-surface-variant text-center">Nothing is added until someone approves the scan on the website.</p>
                </>
              )}

              {mode === 'new' && (
                <form onSubmit={continueNew} className="space-y-3">
                  <div><label className={label} htmlFor="new-code">New stock code</label><input id="new-code" className={`${field} font-mono uppercase`} value={draft.partNumber} onChange={e => setDraft(d => ({ ...d, partNumber: e.target.value }))} placeholder="e.g. CAP-099" autoCapitalize="characters" autoCorrect="off" required autoFocus /></div>
                  <div><label className={label} htmlFor="new-name">Name</label><input id="new-name" className={field} value={draft.name} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} placeholder="e.g. 10uF 0603 X5R 16V" required /></div>
                  <div><label className={label} htmlFor="new-maker">Maker part number <span className="normal-case font-semibold">(optional)</span></label><input id="new-maker" className={`${field} font-mono`} value={draft.makerPartNumber} onChange={e => setDraft(d => ({ ...d, makerPartNumber: e.target.value }))} autoCapitalize="characters" autoCorrect="off" /></div>
                  <div><label className={label} htmlFor="new-desc">Description <span className="normal-case font-semibold">(optional)</span></label><input id="new-desc" className={field} value={draft.description} onChange={e => setDraft(d => ({ ...d, description: e.target.value }))} /></div>
                  <button type="submit" disabled={busy} className={`${big} bg-green-600 text-white`}>{busy && <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />}Continue to quantity</button>
                  <button type="button" onClick={() => { setMode(null); setError(null); }} className="w-full text-sm font-bold text-on-surface-variant py-2">Back</button>
                </form>
              )}

              {mode === 'link' && !po && (
                <div className="space-y-3">
                  <p className="text-sm">Find the item this label belongs to:</p>
                  <form onSubmit={(e) => { e.preventDefault(); void lookUp(typed); }} className="flex gap-2">
                    <div className="relative flex-1">
                      <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none" aria-hidden="true" />
                      <input className={`${field} !pl-10`} value={typed} onChange={e => setTyped(e.target.value)} placeholder="Stock code, name or part number" aria-label="Find the existing item" autoCapitalize="characters" autoCorrect="off" enterKeyHint="search" autoFocus />
                    </div>
                    <button type="submit" disabled={busy || !typed.trim()} className="px-5 rounded-xl bg-surface-container-high border border-white/10 font-bold disabled:opacity-40 inline-flex items-center gap-1.5">{busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : null}Find</button>
                  </form>
                  <button type="button" onClick={() => setCamera('item')} className={`${big} border border-white/10 bg-surface-container-high !py-3`}><ScanLine className="w-5 h-5" aria-hidden="true" />Scan its Tracklab label</button>
                  <button type="button" onClick={() => { setMode(null); setError(null); }} className="w-full text-sm font-bold text-on-surface-variant py-2">Back</button>
                </div>
              )}
            </div>
          </section>
        )}

        {!item && !choices && !unknown && (
          <section className={`${card} p-4 space-y-4`}>
            <button type="button" onClick={() => { setError(null); setNotice(null); setCamera('item'); }} disabled={busy}
              className={`w-full flex flex-col items-center justify-center gap-2 py-8 rounded-2xl border-2 border-dashed ${tone.ring} ${tone.soft} transition-transform active:scale-[0.98] disabled:opacity-40`}>
              <span className={`inline-flex items-center justify-center w-16 h-16 rounded-2xl ${tone.solid} shadow-lg`}><Camera className="w-8 h-8" aria-hidden="true" /></span>
              <span className="text-lg font-black text-on-surface">Scan a label</span>
              <span className="text-xs text-on-surface-variant">{po ? `A reel or bag from ${po.supplier || 'the supplier'} · to receive on ${po.number}` : kit ? `A reel on the pick list · to book out for kit ${kit.name}` : `Reel, bag or item label · to book ${direction === 'IN' ? 'in' : 'out'}`}</span>
            </button>
            <div className="flex items-center gap-3 text-[11px] font-bold uppercase tracking-wide text-on-surface-variant"><span className="h-px flex-1 bg-white/10" />or type it<span className="h-px flex-1 bg-white/10" /></div>
            <form onSubmit={(e) => { e.preventDefault(); void lookUp(typed); }} className="flex gap-2">
              <div className="relative flex-1">
                <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none" aria-hidden="true" />
                <input className={`${field} !pl-10`} value={typed} onChange={e => setTyped(e.target.value)} placeholder={po || kit ? 'Or tap a line above' : 'Stock code or part number'} aria-label="Stock code or part number" autoCapitalize="characters" autoCorrect="off" enterKeyHint="search" />
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
            <button type="button" onClick={() => (unknown ? setChoices(null) : reset())} className={`${big} border border-white/10 !py-3`}>Back</button>
          </section>
        )}

        {item && (
          <form onSubmit={submit} className={`${card} overflow-hidden`}>
            <div className={`px-4 py-3 border-b border-white/[0.07] ${tone.soft} border-x-0 border-t-0 flex items-center gap-2 text-xs font-black uppercase tracking-wide`} data-no-mobile-stack>
              {direction === 'IN' ? <ArrowDownToLine className="w-4 h-4" aria-hidden="true" /> : <ArrowUpFromLine className="w-4 h-4" aria-hidden="true" />}
              {po ? `Receiving on ${po.number}` : kit ? `Picking for kit ${kit.name}` : `Booking ${direction === 'IN' ? 'in' : 'out'}`}
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
              {newItem && (
                <p className="flex items-start gap-2 rounded-xl border border-green-500/25 bg-green-500/10 text-green-400 text-xs font-semibold px-3 py-2.5">
                  <PackagePlus className="w-4 h-4 shrink-0" aria-hidden="true" />New item: it is added to Tracklab when this scan is approved.
                </p>
              )}
              {unknown && !newItem && (
                <p className="flex items-start gap-2 rounded-xl border border-primary/25 bg-primary/10 text-primary text-xs font-semibold px-3 py-2.5">
                  <Link2 className="w-4 h-4 shrink-0" aria-hidden="true" /><span>When approved, the label <span className="font-mono">{unknown.barcodes.join(', ')}</span> is saved on this item, so the next scan finds it.</span>
                </p>
              )}
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
                {po && poLine && (() => { const due = stillDue(poLine.quantity, poLine.received, poLine.waiting); return (
                  <p className={`text-xs mt-1.5 ${qty > due ? 'text-amber-400' : 'text-on-surface-variant'}`}>
                    {po.number}: {poLine.received} of {poLine.quantity} received{poLine.waiting ? `, ${poLine.waiting} waiting for approval` : ''}. {qty > due ? `That's more than the ${due} still due: check the delivery.` : due - qty > 0 ? `${due - qty} still due after this.` : 'This completes the line.'}
                  </p>); })()}
                {kit && pick && (() => { const due = stillDue(pick.need, pick.bookedOut, pick.waiting); return (
                  <p className={`text-xs mt-1.5 ${qty > due ? 'text-amber-400' : 'text-on-surface-variant'}`}>
                    Kit {kit.name} needs {pick.need}{pick.bookedOut + pick.waiting ? `, ${pick.bookedOut + pick.waiting} already sent` : ''}. {qty > due ? `That's more than the ${due} still to pick.` : due - qty > 0 ? `${due - qty} still to pick after this (short: pick the rest from another reel).` : 'This completes it.'}
                  </p>); })()}
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

              <div><label className={label} htmlFor="ref">Reference <span className="normal-case font-semibold">(optional)</span></label><input id="ref" className={field} value={form.reference} onChange={e => setForm(f => ({ ...f, reference: e.target.value }))} placeholder={po ? po.number : kit ? `Kit ${kit.name}` : 'PO, job or order number'} autoCapitalize="characters" /></div>

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
        </>)}

        {!counting && !bomPicking && <section className="pt-2">
          <div className="flex items-center gap-2 mb-2.5" data-no-mobile-stack>
            <h2 className="text-sm font-black">My scans</h2>
            {pending > 0 && <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-primary/15 text-primary">{pending} waiting</span>}
            {mineTotal > 0 && <span className="ml-auto text-[11px] text-on-surface-variant">{mine.length < mineTotal ? `${mine.length} of ${mineTotal}` : `${mineTotal} in all`}</span>}
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
                  <p className="text-xs text-on-surface-variant truncate">{[m.location?.code, m.reference !== m.po?.number && m.reference !== (m.kit ? `Kit ${m.kit.name}` : null) ? m.reference : null, ago(m.capturedAt || m.createdAt)].filter(Boolean).join(' · ')}</p>
                  <p className="mt-1.5 flex flex-wrap gap-1"><StatusChip move={m} />
                    {m.newItem && <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold border bg-green-500/10 text-green-400 border-green-500/25"><PackagePlus className="w-3 h-3" />New item</span>}
                    {!m.newItem && !!m.linkCodes?.length && <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold border bg-primary/10 text-primary border-primary/25"><Link2 className="w-3 h-3" />Barcode</span>}
                    {m.po && <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold border bg-surface-container-high text-on-surface-variant border-white/10"><Truck className="w-3 h-3" />{m.po.number}</span>}
                    {m.kit && <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold border bg-surface-container-high text-on-surface-variant border-white/10"><Boxes className="w-3 h-3" />Kit {m.kit.name}</span>}
                  </p>
                  {m.status === 'REJECTED' && m.rejectReason && <p className="text-xs text-error mt-1">{m.rejectReason}</p>}
                  {m.status === 'APPROVED' && m.stockAfter != null && <p className="text-xs text-on-surface-variant mt-1">Stock now {m.stockAfter}{m.decidedBy ? ` · by ${m.decidedBy}` : ''}</p>}
                </div>
                {m.status === 'PENDING' && <button onClick={() => cancel(m)} className="text-xs font-bold text-error border border-error/30 rounded-lg px-3 py-2 shrink-0 active:bg-error/10">Cancel</button>}
              </li>
            ))}
          </ul>
          {hasMore ? (
            <div ref={moreRef} className="pt-3">
              <button type="button" onClick={() => void loadMore()} disabled={loadingMore} className="w-full rounded-xl border border-white/10 py-3 text-sm font-bold text-on-surface-variant inline-flex items-center justify-center gap-2 disabled:opacity-60">
                {loadingMore ? <><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />Loading older scans…</> : `Show older scans (${mineTotal - mine.length} more)`}
              </button>
            </div>
          ) : mine.length > SCANS_PAGE ? <p className="pt-3 text-center text-xs text-on-surface-variant">That's all your scans.</p> : null}
        </section>}
      </main>

      {showTop && (
        <button type="button" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} aria-label="Back to top"
          className="fixed right-4 z-30 inline-flex items-center gap-1.5 rounded-full bg-primary text-black font-bold text-sm px-4 py-2.5 shadow-lg shadow-black/40"
          style={{ bottom: 'calc(1rem + env(safe-area-inset-bottom))' }}>
          <ArrowUp className="w-4 h-4" aria-hidden="true" />Top
        </button>
      )}

      {camera && (
        <CodeScanner
          title={camera === 'place' ? 'Scan the place' : po ? `Scan to receive on ${po.number}` : kit ? `Scan to pick for ${kit.name}` : `Scan to book ${direction === 'IN' ? 'in' : 'out'}`}
          hint={camera === 'place' ? 'Point at the rack or shelf label' : 'Point at the reel or item label'}
          onClose={() => setCamera(null)}
          onCode={(code) => { const forPlace = camera === 'place'; setCamera(null); void lookUp(code, forPlace); }}
        />
      )}
    </Page>
  );
};
