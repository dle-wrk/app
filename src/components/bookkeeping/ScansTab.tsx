import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, ExternalLink, RefreshCw, Trash2, X } from 'lucide-react';
import { ModuleDataProps, Modal, apiGet, apiDelete, isAdminUser, SecondaryButton, DangerButton, FieldLabel, inputClass, EmptyState, SectionCard } from './shared';
import { openAuthedFile } from '../../lib/openAuthedFile';
import { confirmDialog } from '../../lib/confirmDialog';
import { ScannerStockMoves } from './ScannerStockMoves';

// Pick scans: photos of picked stock sent in by the scanner phone app, with
// the pick note, client, item and quantity typed on the phone. Read-only
// here apart from deleting a wrong one (your own, or any as an admin).

export interface Scan {
  id: number;
  pickNote: string;
  clientName: string | null;
  clientCode: string | null;
  description: string;
  quantity: number;
  user: { id: number | null; name: string; email: string | null };
  capturedAt: string | null;
  createdAt: string;
  imageUrl: string;
  thumbUrl: string;
  client: { id: number; name: string } | null;
  clientOrder: { id: number; number: string } | null;
  dispatchNote: { id: number; number: string; type: string } | null;
}

const PAGE_SIZE = 30;

export const scanWhen = (s: Pick<Scan, 'capturedAt' | 'createdAt'>) => {
  const d = new Date(s.capturedAt || s.createdAt);
  return isNaN(d.getTime()) ? '—' : d.toLocaleString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
export const scanClient = (s: Scan) => s.client?.name || s.clientName || s.clientCode || '—';
const fmtQty = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3))));

/**
 * An image served by /api. A plain <img src> can't be used: the browser
 * would ask for it without the session header and get a 401. It is fetched
 * (the app's fetch adds the header) and shown from a blob: URL.
 */
export const AuthedImage: React.FC<{ src: string; alt: string; className?: string }> = ({ src, alt, className }) => {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    setUrl(null); setFailed(false);
    fetch(src)
      .then(r => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then(b => { made = URL.createObjectURL(b); if (live) setUrl(made); else URL.revokeObjectURL(made); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [src]);
  if (failed) return <div className={`${className || ''} flex items-center justify-center bg-surface-container-high text-outline text-[10px]`}>No photo</div>;
  if (!url) return <div className={`${className || ''} bg-surface-container-high animate-pulse`} aria-label="Loading photo" />;
  return <img src={url} alt={alt} className={className} />;
};

function currentUserId(): number | null {
  try { return Number(JSON.parse(localStorage.getItem('currentUser') || '{}').id) || null; } catch { return null; }
}

const ScanViewer: React.FC<{ scan: Scan; onClose: () => void; onDeleted: () => void; triggerToast: ModuleDataProps['triggerToast'] }> = ({ scan, onClose, onDeleted, triggerToast }) => {
  const [busy, setBusy] = useState(false);
  const canDelete = isAdminUser() || (scan.user.id != null && scan.user.id === currentUserId());
  const remove = async () => {
    if (!(await confirmDialog({ title: 'Delete scan', message: `Delete this scan of "${scan.description}" for pick note ${scan.pickNote}? The photo is deleted with it. This cannot be undone.`, confirmLabel: 'Delete', destructive: true }))) return;
    setBusy(true);
    try {
      await apiDelete(`/api/scans/${scan.id}`);
      triggerToast('Scan deleted.');
      onDeleted();
    } catch (err: any) {
      triggerToast(err.message || 'Failed to delete the scan', 'ERROR');
    } finally { setBusy(false); }
  };
  const open = () => openAuthedFile(scan.imageUrl, `scan-${scan.pickNote}-${scan.id}`).catch((err: any) => triggerToast(err.message || 'Could not open the photo', 'ERROR'));
  const row = (label: string, value: React.ReactNode) => (
    <div className="flex justify-between gap-4 py-1 border-b border-outline-variant/20 text-xs"><span className="text-on-surface-variant">{label}</span><span className="font-semibold text-right">{value}</span></div>
  );
  return (
    <Modal title={`Pick note ${scan.pickNote}`} subtitle={`${scanClient(scan)} · ${scanWhen(scan)}`} onClose={onClose} maxWidth="max-w-3xl">
      <div className="grid grid-cols-1 md:grid-cols-5 gap-md">
        <button type="button" onClick={open} title="Open full size in a new tab" className="md:col-span-3 rounded-lg overflow-hidden border border-outline-variant bg-black/20">
          <AuthedImage src={scan.imageUrl} alt={`Scan of ${scan.description}`} className="w-full max-h-[60vh] min-h-[200px] object-contain" />
        </button>
        <div className="md:col-span-2">
          {row('Item', scan.description)}
          {row('Quantity', <span className="font-mono">{fmtQty(scan.quantity)}</span>)}
          {row('Pick note', <span className="font-mono">{scan.pickNote}</span>)}
          {row('Sales order', scan.clientOrder ? <span className="font-mono text-primary">{scan.clientOrder.number}</span> : <span className="text-outline font-normal">No match</span>)}
          {row(scan.dispatchNote?.type === 'COLLECTION' ? 'Collection note' : 'Delivery note', scan.dispatchNote ? <span className="font-mono text-primary">{scan.dispatchNote.number}</span> : <span className="text-outline font-normal">No match</span>)}
          {row('Client', scan.client ? scan.client.name : <span className="text-outline font-normal">Not linked</span>)}
          {(scan.clientName || scan.clientCode) && row('Typed on phone', [scan.clientName, scan.clientCode].filter(Boolean).join(' · '))}
          {row('Scanned by', scan.user.name)}
          {row('Taken', scanWhen(scan))}
          <div className="flex flex-wrap gap-2 justify-end pt-3">
            <SecondaryButton icon={<ExternalLink className="w-3.5 h-3.5" />} onClick={open}>Open full size</SecondaryButton>
            {canDelete && <DangerButton icon={<Trash2 className="w-3.5 h-3.5" />} onClick={remove} disabled={busy}>Delete</DangerButton>}
          </div>
        </div>
      </div>
    </Modal>
  );
};

/** The Scanner tab: what the phone app sent in, as stock bookings or as pick scan photos. */
export const ScansTab: React.FC<ModuleDataProps> = (props) => {
  const [view, setView] = useState<'STOCK' | 'PICKS'>(() => {
    try { return localStorage.getItem('scannerTabView') === 'PICKS' ? 'PICKS' : 'STOCK'; } catch { return 'STOCK'; }
  });
  const choose = (v: 'STOCK' | 'PICKS') => { setView(v); try { localStorage.setItem('scannerTabView', v); } catch { /* remembered only when it can be */ } };
  const tab = (v: 'STOCK' | 'PICKS', label: string) => (
    <button onClick={() => choose(v)} aria-pressed={view === v} className={`px-3 py-1.5 rounded text-xs font-bold transition-all ${view === v ? 'bg-primary text-white' : 'text-on-surface-variant hover:text-on-surface'}`}>{label}</button>
  );
  return (
    <div className="space-y-4">
      <div className="inline-flex gap-1 p-1 rounded-lg bg-surface-container border border-outline-variant">
        {tab('STOCK', 'Stock in & out')}
        {tab('PICKS', 'Pick scans')}
      </div>
      {view === 'STOCK' ? <ScannerStockMoves triggerToast={props.triggerToast} refresh={props.refresh} /> : <PickScansPanel {...props} />}
    </div>
  );
};

const PickScansPanel: React.FC<ModuleDataProps> = ({ triggerToast }) => {
  const [filters, setFilters] = useState({ pickNote: '', user: '', client: '', from: '', to: '' });
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: Scan[]; total: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [viewing, setViewing] = useState<Scan | null>(null);
  const latest = useRef(0);

  const load = useCallback(async (f = filters, p = page) => {
    const mine = ++latest.current; // a slower, older answer must not overwrite a newer one
    setLoading(true);
    try {
      const qs = new URLSearchParams({ page: String(p), pageSize: String(PAGE_SIZE) });
      for (const [k, v] of Object.entries(f)) if (v.trim()) qs.set(k, v.trim());
      const res = await apiGet(`/api/scans?${qs}`);
      if (mine === latest.current) setData({ items: res.items || [], total: res.total || 0 });
    } catch (err: any) {
      if (mine === latest.current) triggerToast(err.message || 'Failed to load scans', 'ERROR');
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  }, [filters, page, triggerToast]);

  // Typing in a filter waits a moment before asking the server.
  useEffect(() => {
    const t = window.setTimeout(() => { void load(filters, page); }, 250);
    return () => window.clearTimeout(t);
  }, [filters, page]); // eslint-disable-line react-hooks/exhaustive-deps

  const setFilter = (k: keyof typeof filters, v: string) => { setFilters(f => ({ ...f, [k]: v })); setPage(1); };
  const anyFilter = Object.values(filters).some(v => v.trim());
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <SectionCard
        title="Pick Scans"
        badge={data ? `${total} ${total === 1 ? 'scan' : 'scans'}` : undefined}
        actions={
          <>
            <span className="text-[10px] text-outline hidden md:inline">Photos sent from the scanner phone app</span>
            <SecondaryButton icon={<RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />} onClick={() => load()} disabled={loading}>Refresh</SecondaryButton>
          </>
        }
      >
        <div className="grid grid-cols-2 md:grid-cols-6 gap-2 px-lg py-sm border-b border-outline-variant/40">
          <div><FieldLabel>Pick note</FieldLabel><input className={inputClass} value={filters.pickNote} onChange={e => setFilter('pickNote', e.target.value)} placeholder="SO- / DN- number" /></div>
          <div><FieldLabel>Scanned by</FieldLabel><input className={inputClass} value={filters.user} onChange={e => setFilter('user', e.target.value)} placeholder="Name or email" /></div>
          <div><FieldLabel>Client</FieldLabel><input className={inputClass} value={filters.client} onChange={e => setFilter('client', e.target.value)} placeholder="Name or code" /></div>
          <div><FieldLabel>From</FieldLabel><input type="date" className={inputClass} value={filters.from} onChange={e => setFilter('from', e.target.value)} /></div>
          <div><FieldLabel>To</FieldLabel><input type="date" className={inputClass} value={filters.to} onChange={e => setFilter('to', e.target.value)} /></div>
          <div className="flex items-end">
            {anyFilter && <SecondaryButton icon={<X className="w-3.5 h-3.5" />} onClick={() => { setFilters({ pickNote: '', user: '', client: '', from: '', to: '' }); setPage(1); }}>Clear filters</SecondaryButton>}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-surface-container-high/50 text-[10px] uppercase font-bold text-outline border-b border-outline-variant">
                <th className="px-lg py-sm w-16">Photo</th>
                <th className="px-lg py-sm">Pick note</th>
                <th className="px-lg py-sm">Client</th>
                <th className="px-lg py-sm">Item</th>
                <th className="px-lg py-sm text-right">Qty</th>
                <th className="px-lg py-sm">Scanned by</th>
                <th className="px-lg py-sm">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/30">
              {(data?.items || []).map(s => (
                <tr key={s.id} className="hover:bg-surface-variant/20 transition-all cursor-pointer" onClick={() => setViewing(s)}>
                  <td className="px-lg py-1.5"><AuthedImage src={s.thumbUrl} alt="" className="w-12 h-12 object-cover rounded border border-outline-variant" /></td>
                  <td className="px-lg py-sm">
                    <span className="font-mono font-bold text-primary">{s.pickNote}</span>
                    {(s.clientOrder || s.dispatchNote) ? (
                      <span className="block text-[10px] text-green-400">
                        {[s.clientOrder && `Order ${s.clientOrder.number}`, s.dispatchNote && `${s.dispatchNote.type === 'COLLECTION' ? 'Collection' : 'Delivery'} ${s.dispatchNote.number}`].filter(Boolean).join(' · ')}
                      </span>
                    ) : <span className="block text-[10px] text-outline" title="This number is not a sales order or delivery / collection note in Tracklab">No matching order</span>}
                  </td>
                  <td className="px-lg py-sm font-semibold">{scanClient(s)}</td>
                  <td className="px-lg py-sm text-on-surface-variant">{s.description}</td>
                  <td className="px-lg py-sm text-right font-mono font-bold">{fmtQty(s.quantity)}</td>
                  <td className="px-lg py-sm text-on-surface-variant">{s.user.name}</td>
                  <td className="px-lg py-sm text-on-surface-variant whitespace-nowrap">{scanWhen(s)}</td>
                </tr>
              ))}
              {data && data.items.length === 0 && <EmptyState message={anyFilter ? 'No scans match these filters.' : 'No scans yet. They appear here as soon as someone saves one in the scanner app.'} colSpan={7} />}
              {!data && <EmptyState message="Loading scans…" colSpan={7} />}
            </tbody>
          </table>
        </div>
        {pages > 1 && (
          <div className="flex items-center justify-between px-lg py-sm border-t border-outline-variant/40 text-xs text-on-surface-variant">
            <span>Page {page} of {pages}</span>
            <span className="flex gap-2">
              <SecondaryButton onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1 || loading}>Previous</SecondaryButton>
              <SecondaryButton onClick={() => setPage(p => Math.min(pages, p + 1))} disabled={page >= pages || loading}>Next</SecondaryButton>
            </span>
          </div>
        )}
      </SectionCard>

      {viewing && (
        <ScanViewer scan={viewing} triggerToast={triggerToast} onClose={() => setViewing(null)} onDeleted={() => { setViewing(null); void load(); }} />
      )}
    </div>
  );
};

/**
 * The scans linked to one sales order or delivery / collection note, as a
 * strip of thumbnails in that document's viewer. Shows nothing when there
 * are none (most documents), so it costs the viewer no space.
 */
export const RelatedScans: React.FC<{ clientOrderId?: number; dispatchNoteId?: number; triggerToast: ModuleDataProps['triggerToast'] }> = ({ clientOrderId, dispatchNoteId, triggerToast }) => {
  const [scans, setScans] = useState<Scan[]>([]);
  const [total, setTotal] = useState(0);
  const [viewing, setViewing] = useState<Scan | null>(null);
  const load = useCallback(() => {
    const qs = new URLSearchParams({ pageSize: '24' });
    if (clientOrderId) qs.set('clientOrderId', String(clientOrderId));
    else if (dispatchNoteId) qs.set('dispatchNoteId', String(dispatchNoteId));
    else return;
    apiGet(`/api/scans?${qs}`).then(r => { setScans(r.items || []); setTotal(r.total || 0); }).catch(() => { /* the viewer works without them */ });
  }, [clientOrderId, dispatchNoteId]);
  useEffect(() => { load(); }, [load]);
  if (scans.length === 0) return null;
  return (
    <div className="mb-md">
      <div className="flex items-center gap-1.5 text-[10px] uppercase font-bold text-primary mb-1.5">
        <Camera className="w-3.5 h-3.5" /> Pick scans · {total}{total > scans.length ? ` (showing the latest ${scans.length})` : ''}
      </div>
      <div className="flex flex-wrap gap-2">
        {scans.map(s => (
          <button key={s.id} type="button" onClick={() => setViewing(s)} title={`${s.description} × ${fmtQty(s.quantity)} · ${s.user.name} · ${scanWhen(s)}`} className="w-24 text-left rounded-lg border border-outline-variant overflow-hidden hover:border-primary transition-colors">
            <AuthedImage src={s.thumbUrl} alt={s.description} className="w-24 h-20 object-cover" />
            <span className="block px-1.5 py-1 text-[10px] leading-tight truncate">{fmtQty(s.quantity)} × {s.description}</span>
          </button>
        ))}
      </div>
      {viewing && <ScanViewer scan={viewing} triggerToast={triggerToast} onClose={() => setViewing(null)} onDeleted={() => { setViewing(null); load(); }} />}
    </div>
  );
};
