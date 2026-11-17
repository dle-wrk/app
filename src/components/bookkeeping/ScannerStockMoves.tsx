import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Check, RefreshCw, X } from 'lucide-react';
import { ModuleDataProps, apiGet, apiPost, PrimaryButton, SecondaryButton, DangerButton, FieldLabel, inputClass, selectClass, EmptyState, SectionCard } from './shared';
import { canChange } from '../../lib/changeAccess';
import { confirmDialog } from '../../lib/confirmDialog';

// Stock scanned in and out with the scanner (the phone page at /scan, or the
// phone app). A scan arrives here as Pending and changes nothing until it is
// approved; approving makes it a normal stock movement on its item
// (reference "Scanner: …"). The list re-reads itself every few seconds, so
// scans show up while they are being made.

export interface StockMove {
  id: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  direction: 'IN' | 'OUT';
  partNumber: string;
  itemName: string | null;
  quantity: number;
  stockAfter: number | null;
  location: { id: number | null; code: string } | null;
  lot: string | null;
  dateCode: string | null;
  reference: string | null;
  note: string | null;
  user: { id: number | null; name: string; email: string | null };
  capturedAt: string | null;
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  rejectReason: string | null;
}

const PAGE_SIZE = 30;
const REFRESH_MS = 10_000;
const fmtWhen = (v: string | null) => {
  const d = new Date(v || '');
  return isNaN(d.getTime()) ? '—' : d.toLocaleString('en-ZA', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const EMPTY = { status: 'PENDING', direction: '', part: '', user: '', from: '', to: '' };

export const DirectionPill: React.FC<{ direction: 'IN' | 'OUT' }> = ({ direction }) => direction === 'IN'
  ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-green-500/10 text-green-400 border border-green-500/20"><ArrowDownToLine className="w-3 h-3" /> IN</span>
  : <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/10 text-amber-500 border border-amber-500/20"><ArrowUpFromLine className="w-3 h-3" /> OUT</span>;

export const MoveStatusPill: React.FC<{ move: Pick<StockMove, 'status' | 'decidedBy' | 'decidedAt' | 'rejectReason'> }> = ({ move }) => {
  const cls = move.status === 'PENDING' ? 'bg-primary/10 text-primary border-primary/30'
    : move.status === 'APPROVED' ? 'bg-green-500/10 text-green-400 border-green-500/20'
    : 'bg-error/10 text-error border-error/20';
  const label = move.status === 'PENDING' ? 'Pending' : move.status === 'APPROVED' ? 'Approved' : 'Rejected';
  return (
    <span>
      <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-bold border ${cls}`}>{label}</span>
      {move.status !== 'PENDING' && move.decidedBy && <span className="block text-[10px] text-on-surface-variant mt-0.5">{move.decidedBy} · {fmtWhen(move.decidedAt)}</span>}
      {move.status === 'REJECTED' && move.rejectReason && <span className="block text-[10px] text-error">{move.rejectReason}</span>}
    </span>
  );
};

export const ScannerStockMoves: React.FC<Pick<ModuleDataProps, 'triggerToast' | 'refresh'>> = ({ triggerToast, refresh }) => {
  const [filters, setFilters] = useState(EMPTY);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: StockMove[]; total: number; pending: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);
  const canDecide = canChange('/api/stock-moves/decide', 'POST');

  const load = useCallback(async (f = filters, p = page, quiet = false) => {
    const mine = ++latest.current; // a slower, older answer must not overwrite a newer one
    if (!quiet) setLoading(true);
    try {
      const qs = new URLSearchParams({ page: String(p), pageSize: String(PAGE_SIZE) });
      for (const [k, v] of Object.entries(f)) if (v.trim()) qs.set(k, v.trim());
      const res = await apiGet(`/api/stock-moves?${qs}`);
      if (mine === latest.current) setData({ items: res.items || [], total: res.total || 0, pending: res.pending || 0 });
    } catch (err: any) {
      if (mine === latest.current && !quiet) triggerToast(err.message || 'Failed to load scans', 'ERROR');
    } finally {
      if (mine === latest.current && !quiet) setLoading(false);
    }
  }, [filters, page, triggerToast]);

  useEffect(() => {
    const t = window.setTimeout(() => { void load(filters, page); }, 250);
    return () => window.clearTimeout(t);
  }, [filters, page]); // eslint-disable-line react-hooks/exhaustive-deps

  // New scans appear on their own: re-read quietly while the tab is in view.
  useEffect(() => {
    const t = window.setInterval(() => { if (!document.hidden && !busy) void load(filters, page, true); }, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [filters, page, busy, load]);

  const decide = async (ids: number[], decision: 'APPROVE' | 'REJECT', reason?: string) => {
    setBusy(true);
    try {
      const res = await apiPost('/api/stock-moves/decide', { ids, decision, reason });
      const failed: { id: number; error: string }[] = (res.results || []).filter((r: any) => !r.ok);
      const verb = decision === 'APPROVE' ? 'approved' : 'rejected';
      if (res.done) triggerToast(`${res.done} ${res.done === 1 ? 'scan' : 'scans'} ${verb}${decision === 'APPROVE' ? ': stock updated' : ''}.`);
      if (failed.length) {
        const item = (id: number) => data?.items.find(m => m.id === id)?.partNumber || `scan ${id}`;
        triggerToast(`${failed.length === 1 ? '' : `${failed.length} not ${verb}. First: `}${item(failed[0].id)}: ${failed[0].error}`, 'ERROR');
      }
      await load(filters, page, true);
      if (decision === 'APPROVE' && res.done) void refresh(); // stock totals elsewhere in the app
    } catch (err: any) {
      triggerToast(err.message || 'Failed to save the decision', 'ERROR');
    } finally { setBusy(false); }
  };

  const reject = async (m: StockMove) => {
    if (!(await confirmDialog({ title: 'Reject scan', message: `Reject this scan: ${m.direction === 'IN' ? 'book in' : 'book out'} ${m.quantity} × ${m.partNumber}, scanned by ${m.user.name}? Stock does not change. This cannot be undone; the item would have to be scanned again.`, confirmLabel: 'Reject', destructive: true }))) return;
    await decide([m.id], 'REJECT');
  };

  const shownPending = (data?.items || []).filter(m => m.status === 'PENDING');
  const approveShown = async () => {
    if (!(await confirmDialog({ title: 'Approve scans', message: `Approve the ${shownPending.length} pending ${shownPending.length === 1 ? 'scan' : 'scans'} shown here? Stock changes for each one. A scan that no longer fits (not enough stock to book out) is left pending and reported.`, confirmLabel: `Approve ${shownPending.length}` }))) return;
    // Oldest first, so a book-in is applied before a book-out that depends on it.
    await decide(shownPending.map(m => m.id).sort((a, b) => a - b), 'APPROVE');
  };

  const setFilter = (k: keyof typeof EMPTY, v: string) => { setFilters(f => ({ ...f, [k]: v })); setPage(1); };
  const anyFilter = (Object.keys(EMPTY) as (keyof typeof EMPTY)[]).some(k => filters[k].trim() !== EMPTY[k]);
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const cols = canDecide ? 9 : 8;

  return (
    <SectionCard
      title="Stock scanned in & out"
      badge={data ? `${data.pending} waiting for approval` : undefined}
      actions={
        <>
          {canDecide && shownPending.length > 1 && <PrimaryButton icon={<Check className="w-3.5 h-3.5" />} onClick={approveShown} disabled={busy}>Approve all shown ({shownPending.length})</PrimaryButton>}
          <SecondaryButton icon={<RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />} onClick={() => load()} disabled={loading}>Refresh</SecondaryButton>
        </>
      }
    >
      <div className="grid grid-cols-2 md:grid-cols-7 gap-2 px-lg py-sm border-b border-outline-variant/40">
        <div>
          <FieldLabel>Status</FieldLabel>
          <select className={selectClass} value={filters.status} onChange={e => setFilter('status', e.target.value)} aria-label="Status">
            <option value="PENDING">Pending</option>
            <option value="APPROVED">Approved</option>
            <option value="REJECTED">Rejected</option>
            <option value="">All</option>
          </select>
        </div>
        <div>
          <FieldLabel>In or out</FieldLabel>
          <select className={selectClass} value={filters.direction} onChange={e => setFilter('direction', e.target.value)} aria-label="In or out">
            <option value="">Both</option>
            <option value="IN">Booked in</option>
            <option value="OUT">Booked out</option>
          </select>
        </div>
        <div><FieldLabel>Item</FieldLabel><input className={inputClass} value={filters.part} onChange={e => setFilter('part', e.target.value)} placeholder="Stock code or name" /></div>
        <div><FieldLabel>Scanned by</FieldLabel><input className={inputClass} value={filters.user} onChange={e => setFilter('user', e.target.value)} placeholder="Name or email" /></div>
        <div><FieldLabel>From</FieldLabel><input type="date" className={inputClass} value={filters.from} onChange={e => setFilter('from', e.target.value)} /></div>
        <div><FieldLabel>To</FieldLabel><input type="date" className={inputClass} value={filters.to} onChange={e => setFilter('to', e.target.value)} /></div>
        <div className="flex items-end">
          {anyFilter && <SecondaryButton icon={<X className="w-3.5 h-3.5" />} onClick={() => { setFilters(EMPTY); setPage(1); }}>Reset filters</SecondaryButton>}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="bg-surface-container-high/50 text-[10px] uppercase font-bold text-outline border-b border-outline-variant">
              <th className="px-lg py-sm">In / out</th>
              <th className="px-lg py-sm">Item</th>
              <th className="px-lg py-sm text-right">Qty</th>
              <th className="px-lg py-sm">Location</th>
              <th className="px-lg py-sm">Reference</th>
              <th className="px-lg py-sm">Scanned by</th>
              <th className="px-lg py-sm">Scanned</th>
              <th className="px-lg py-sm">Status</th>
              {canDecide && <th className="px-lg py-sm text-right">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-outline-variant/30">
            {(data?.items || []).map(m => (
              <tr key={m.id} className="hover:bg-surface-variant/20 transition-all">
                <td className="px-lg py-sm"><DirectionPill direction={m.direction} /></td>
                <td className="px-lg py-sm">
                  <span className="font-mono font-bold text-primary">{m.partNumber}</span>
                  {m.itemName && m.itemName !== m.partNumber && <span className="block text-[10px] text-on-surface-variant">{m.itemName}</span>}
                </td>
                <td className="px-lg py-sm text-right font-mono font-bold whitespace-nowrap">
                  {m.direction === 'IN' ? '+' : '−'}{m.quantity}
                  {m.status === 'APPROVED' && m.stockAfter != null && <span className="block text-[10px] font-normal text-on-surface-variant">stock {m.stockAfter}</span>}
                </td>
                <td className="px-lg py-sm">
                  {m.location ? <span className="font-mono">{m.location.code}</span> : <span className="text-outline">{m.direction === 'IN' ? 'Not put away' : 'Oldest stock first'}</span>}
                  {(m.lot || m.dateCode) && <span className="block text-[10px] text-on-surface-variant">{[m.lot && `Lot ${m.lot}`, m.dateCode && `D/C ${m.dateCode}`].filter(Boolean).join(' · ')}</span>}
                </td>
                <td className="px-lg py-sm text-on-surface-variant">{[m.reference, m.note].filter(Boolean).join(' · ') || '—'}</td>
                <td className="px-lg py-sm text-on-surface-variant">{m.user.name}</td>
                <td className="px-lg py-sm text-on-surface-variant whitespace-nowrap">{fmtWhen(m.capturedAt || m.createdAt)}</td>
                <td className="px-lg py-sm"><MoveStatusPill move={m} /></td>
                {canDecide && (
                  <td className="px-lg py-sm text-right whitespace-nowrap">
                    {m.status === 'PENDING' && (
                      <span className="inline-flex gap-1.5">
                        <PrimaryButton icon={<Check className="w-3.5 h-3.5" />} onClick={() => decide([m.id], 'APPROVE')} disabled={busy} aria-label={`Approve ${m.partNumber}`}>Approve</PrimaryButton>
                        <DangerButton icon={<X className="w-3.5 h-3.5" />} onClick={() => reject(m)} disabled={busy} aria-label={`Reject ${m.partNumber}`}>Reject</DangerButton>
                      </span>
                    )}
                  </td>
                )}
              </tr>
            ))}
            {data && data.items.length === 0 && <EmptyState colSpan={cols} message={
              filters.status === 'PENDING' && !anyFilter ? 'Nothing waiting for approval. Scans appear here as soon as they are made on a phone.'
              : 'No scans match these filters.'} />}
            {!data && <EmptyState message="Loading scans…" colSpan={cols} />}
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
  );
};
