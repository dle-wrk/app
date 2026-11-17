import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, RefreshCw, X } from 'lucide-react';
import { ModuleDataProps, apiGet, SecondaryButton, FieldLabel, inputClass, selectClass, EmptyState, SectionCard } from './shared';

// Stock booked in and out with the scanner phone app. Each row is also a
// normal stock movement on its item (reference "Scanner: …"), so this is a
// view of who booked what from the phone, not a second set of books.

interface StockMove {
  id: number;
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
}

const PAGE_SIZE = 30;
const when = (m: StockMove) => {
  const d = new Date(m.capturedAt || m.createdAt);
  return isNaN(d.getTime()) ? '—' : d.toLocaleString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const EMPTY = { direction: '', part: '', user: '', from: '', to: '' };

export const ScannerStockMoves: React.FC<Pick<ModuleDataProps, 'triggerToast'>> = ({ triggerToast }) => {
  const [filters, setFilters] = useState(EMPTY);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: StockMove[]; total: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const latest = useRef(0);

  const load = useCallback(async (f = filters, p = page) => {
    const mine = ++latest.current;
    setLoading(true);
    try {
      const qs = new URLSearchParams({ page: String(p), pageSize: String(PAGE_SIZE) });
      for (const [k, v] of Object.entries(f)) if (v.trim()) qs.set(k, v.trim());
      const res = await apiGet(`/api/stock-moves?${qs}`);
      if (mine === latest.current) setData({ items: res.items || [], total: res.total || 0 });
    } catch (err: any) {
      if (mine === latest.current) triggerToast(err.message || 'Failed to load scanner bookings', 'ERROR');
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  }, [filters, page, triggerToast]);

  useEffect(() => {
    const t = window.setTimeout(() => { void load(filters, page); }, 250);
    return () => window.clearTimeout(t);
  }, [filters, page]); // eslint-disable-line react-hooks/exhaustive-deps

  const setFilter = (k: keyof typeof EMPTY, v: string) => { setFilters(f => ({ ...f, [k]: v })); setPage(1); };
  const anyFilter = Object.values(filters).some(v => v.trim());
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <SectionCard
      title="Stock booked with the scanner"
      badge={data ? `${total} ${total === 1 ? 'booking' : 'bookings'}` : undefined}
      actions={<SecondaryButton icon={<RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />} onClick={() => load()} disabled={loading}>Refresh</SecondaryButton>}
    >
      <div className="grid grid-cols-2 md:grid-cols-6 gap-2 px-lg py-sm border-b border-outline-variant/40">
        <div>
          <FieldLabel>In or out</FieldLabel>
          <select className={selectClass} value={filters.direction} onChange={e => setFilter('direction', e.target.value)}>
            <option value="">Both</option>
            <option value="IN">Booked in</option>
            <option value="OUT">Booked out</option>
          </select>
        </div>
        <div><FieldLabel>Item</FieldLabel><input className={inputClass} value={filters.part} onChange={e => setFilter('part', e.target.value)} placeholder="Stock code or name" /></div>
        <div><FieldLabel>Booked by</FieldLabel><input className={inputClass} value={filters.user} onChange={e => setFilter('user', e.target.value)} placeholder="Name or email" /></div>
        <div><FieldLabel>From</FieldLabel><input type="date" className={inputClass} value={filters.from} onChange={e => setFilter('from', e.target.value)} /></div>
        <div><FieldLabel>To</FieldLabel><input type="date" className={inputClass} value={filters.to} onChange={e => setFilter('to', e.target.value)} /></div>
        <div className="flex items-end">
          {anyFilter && <SecondaryButton icon={<X className="w-3.5 h-3.5" />} onClick={() => { setFilters(EMPTY); setPage(1); }}>Clear filters</SecondaryButton>}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="bg-surface-container-high/50 text-[10px] uppercase font-bold text-outline border-b border-outline-variant">
              <th className="px-lg py-sm">In / out</th>
              <th className="px-lg py-sm">Item</th>
              <th className="px-lg py-sm text-right">Qty</th>
              <th className="px-lg py-sm text-right">Stock after</th>
              <th className="px-lg py-sm">Location</th>
              <th className="px-lg py-sm">Reference</th>
              <th className="px-lg py-sm">Booked by</th>
              <th className="px-lg py-sm">Date</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-outline-variant/30">
            {(data?.items || []).map(m => (
              <tr key={m.id} className="hover:bg-surface-variant/20 transition-all">
                <td className="px-lg py-sm">
                  {m.direction === 'IN'
                    ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-green-500/10 text-green-400 border border-green-500/20"><ArrowDownToLine className="w-3 h-3" /> IN</span>
                    : <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/10 text-amber-500 border border-amber-500/20"><ArrowUpFromLine className="w-3 h-3" /> OUT</span>}
                </td>
                <td className="px-lg py-sm">
                  <span className="font-mono font-bold text-primary">{m.partNumber}</span>
                  {m.itemName && m.itemName !== m.partNumber && <span className="block text-[10px] text-on-surface-variant">{m.itemName}</span>}
                </td>
                <td className="px-lg py-sm text-right font-mono font-bold">{m.direction === 'IN' ? '+' : '−'}{m.quantity}</td>
                <td className="px-lg py-sm text-right font-mono text-on-surface-variant">{m.stockAfter ?? '—'}</td>
                <td className="px-lg py-sm">
                  {m.location ? <span className="font-mono">{m.location.code}</span> : <span className="text-outline">{m.direction === 'IN' ? 'Not put away' : 'Oldest stock first'}</span>}
                  {(m.lot || m.dateCode) && <span className="block text-[10px] text-on-surface-variant">{[m.lot && `Lot ${m.lot}`, m.dateCode && `D/C ${m.dateCode}`].filter(Boolean).join(' · ')}</span>}
                </td>
                <td className="px-lg py-sm text-on-surface-variant">{[m.reference, m.note].filter(Boolean).join(' · ') || '—'}</td>
                <td className="px-lg py-sm text-on-surface-variant">{m.user.name}</td>
                <td className="px-lg py-sm text-on-surface-variant whitespace-nowrap">{when(m)}</td>
              </tr>
            ))}
            {data && data.items.length === 0 && <EmptyState message={anyFilter ? 'No bookings match these filters.' : 'Nothing booked with the scanner yet. Bookings appear here, and on each item\'s stock history, as soon as they are made on the phone.'} colSpan={8} />}
            {!data && <EmptyState message="Loading bookings…" colSpan={8} />}
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
