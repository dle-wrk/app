// "Add package" in the sales line editor (sales orders, quotes, invoices): a
// panel listing the active Sales Builder packages, the client's own first.
// Choosing one asks the server to expand it (packages inside, discount lines,
// converted to the order currency) and hands the lines back. A panel rather
// than a second window, so Escape can't close the order by accident.

import React, { useEffect, useMemo, useState } from 'react';
import { Package, Search, X, AlertTriangle, Loader2 } from 'lucide-react';
import { apiGet } from './shared';
import { fmtZAR } from '../../lib/formatMoney';
import type { ExpandedLine } from '../../lib/salesPackages';

export interface PackageSummary {
  id: number; name: string; category: string | null; tags: string[]; clientId: number | null; clientName: string | null;
  active: boolean; lines: unknown[]; totals: { total: number } | null; warnings: string[]; error: string | null; discountPct: number;
}
export interface ExpandedPackage { id: number; name: string; notes: string | null; currency: string; zarPerUnit: number | null; lines: ExpandedLine[]; warnings: string[] }

export const PackagePicker: React.FC<{
  clientId: number | null;
  currency: string;
  onAdd: (pkg: ExpandedPackage) => void;
  onClose: () => void;
}> = ({ clientId, currency, onAdd, onClose }) => {
  const [list, setList] = useState<PackageSummary[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiGet('/api/sales-packages').then((rows: PackageSummary[]) => { if (!cancelled) setList(Array.isArray(rows) ? rows : []); })
      .catch((e: any) => { if (!cancelled) setFailed(e?.message || 'Could not load the packages.'); });
    return () => { cancelled = true; };
  }, []);

  const shown = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (list ?? [])
      .filter((p) => p.active && !p.error)
      .filter((p) => p.clientId === null || p.clientId === clientId)
      .filter((p) => words.every((w) => [p.name, p.category, ...(p.tags || [])].filter(Boolean).join(' ').toLowerCase().includes(w)))
      .sort((a, b) => Number(b.clientId === clientId && clientId !== null) - Number(a.clientId === clientId && clientId !== null) || a.name.localeCompare(b.name));
  }, [list, q, clientId]);

  const add = async (id: number) => {
    setAdding(id);
    try {
      const pkg: ExpandedPackage = await apiGet(`/api/sales-packages/${id}/expand?currency=${encodeURIComponent(currency || 'ZAR')}`);
      onAdd(pkg);
    } catch (e: any) {
      setFailed(e?.message || 'Could not add that package.');
    } finally {
      setAdding(null);
    }
  };

  return (
    <div className="rounded-lg border border-primary/40 bg-surface-container-high/60 p-3 space-y-2" data-testid="package-picker">
      <div className="flex items-center gap-2">
        <Package className="w-4 h-4 text-primary shrink-0" />
        <div className="relative flex-1">
          <Search className="w-3.5 h-3.5 text-outline absolute left-2 top-1/2 -translate-y-1/2" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search packages by name, category or tag…" aria-label="Search packages"
            className="w-full rounded-lg border border-outline-variant bg-surface-container-low pl-7 pr-2 py-1.5 text-xs text-on-surface focus:outline-none focus:border-primary" />
        </div>
        <button type="button" onClick={onClose} aria-label="Close packages" className="p-1 rounded text-outline hover:text-on-surface"><X className="w-4 h-4" /></button>
      </div>
      {failed && <p className="text-[11px] text-error">{failed}</p>}
      {!list && !failed && <p className="text-[11px] text-outline flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Loading packages…</p>}
      {list && shown.length === 0 && (
        <p className="text-[11px] text-on-surface-variant">{list.length ? 'No package matches.' : 'No packages yet: admins and managers make them in Bookkeeping → Sales → Sales Builder.'}</p>
      )}
      <ul className="max-h-[280px] overflow-y-auto divide-y divide-outline-variant/30">
        {shown.map((p) => (
          <li key={p.id} className="py-1.5 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-xs font-bold text-on-surface truncate">
                {p.name}
                {p.clientId !== null && <span className="ml-1.5 text-[9px] font-bold uppercase text-primary bg-primary/10 rounded px-1">For {p.clientName || 'this client'}</span>}
              </div>
              <div className="text-[10px] text-outline">
                {[p.category, `${p.lines.length} line${p.lines.length === 1 ? '' : 's'}`, p.totals ? `${fmtZAR(p.totals.total)} excl. VAT` : null, p.discountPct ? `${p.discountPct}% off` : null].filter(Boolean).join(' · ')}
              </div>
              {p.warnings.length > 0 && <div className="text-[10px] text-amber-500 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> {p.warnings[0]}{p.warnings.length > 1 ? ` (+${p.warnings.length - 1})` : ''}</div>}
            </div>
            <button type="button" onClick={() => void add(p.id)} disabled={adding !== null} aria-label={`Add package ${p.name}`}
              className="shrink-0 px-2 py-1 rounded bg-primary text-white text-[11px] font-bold disabled:opacity-50">
              {adding === p.id ? 'Adding…' : 'Add'}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
};
