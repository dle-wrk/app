import React, { useState, useMemo } from 'react';
import {
  Lock,
  Search,
  RefreshCw,
  Check,
  TrendingDown,
  Sparkles,
  ArrowRight,
  Loader2,
  AlertCircle
} from 'lucide-react';
import { Item } from '../types';

interface BulkPricingWizardProps {
  items: Item[];
  onUpdatePrices: (prices: { partNumber: string; price: number }[]) => void;
  onShowNotification: (msg: string) => void;
  onClose?: () => void;
}

type ProviderLabel = 'Mouser' | 'DigiKey' | 'LCSC';

interface FetchedPrice {
  price: number | null;
  currency: string | null;
  provider: ProviderLabel | null;
  breakQty: number | null;
  error?: string;
}

const QTY_OPTIONS = [1, 10, 100, 1000];

// Supplier prices are held for 30 days. A part priced inside that window is not
// re-queried and does not appear in the list — it only returns once stale.
const CACHE_DAYS = 30;

// Reads the live /api/pricing/search response and picks the best price for a given part,
// preferring the supplier the part is classified under, then falling back to any provider
// that returned a real unit price.
function pickProviderPrice(
  entry: { isMouser: boolean; isDigiKey: boolean; isLcsc: boolean },
  data: any
): FetchedPrice {
  const order: Array<[ProviderLabel, string]> = [];
  if (entry.isMouser) order.push(['Mouser', 'mouser']);
  if (entry.isDigiKey) order.push(['DigiKey', 'digikey']);
  if (entry.isLcsc) order.push(['LCSC', 'lcsc']);
  // Fallbacks — classification is heuristic, so accept any provider that has a price.
  order.push(['Mouser', 'mouser'], ['DigiKey', 'digikey'], ['LCSC', 'lcsc']);

  for (const [label, key] of order) {
    const p = data?.[key];
    if (p && typeof p.unitPrice === 'number' && Number.isFinite(p.unitPrice)) {
      return { price: p.unitPrice, currency: p.currency ?? null, provider: label, breakQty: p.breakQuantity ?? null };
    }
  }
  const errKey = entry.isMouser ? 'mouser' : entry.isDigiKey ? 'digikey' : entry.isLcsc ? 'lcsc' : 'mouser';
  const err = data?.[errKey]?.error || data?.digikey?.error || data?.mouser?.error || data?.lcsc?.error || 'No price found';
  return { price: null, currency: null, provider: null, breakQty: null, error: err };
}

export default function BulkPricingWizard({ items, onUpdatePrices, onShowNotification }: BulkPricingWizardProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [targetQty, setTargetQty] = useState(1000);
  const [isQuerying, setIsQuerying] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string }>({ done: 0, total: 0, current: '' });
  const [fetched, setFetched] = useState<Record<string, FetchedPrice>>({});
  const [selectedItems, setSelectedItems] = useState<Record<string, boolean>>({});
  // Parts already priced inside the 30-day cache window, keyed by MFN. These are
  // hidden from the list and excluded from queries until the cache goes stale,
  // so applying live rates does not mean re-paying for the same lookups.
  const [cachedMfns, setCachedMfns] = useState<Record<string, { cachedAt: string; ageDays: number }>>({});
  const [showCached, setShowCached] = useState(false);

  const loadCacheStatus = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/pricing/cache-status?qty=${targetQty}&maxAgeDays=${CACHE_DAYS}`);
      if (!res.ok) return;
      const data = await res.json();
      setCachedMfns(data.fresh || {});
    } catch {
      // Non-fatal: without cache status everything simply shows as unqueried.
    }
  }, [targetQty]);

  React.useEffect(() => { loadCacheStatus(); }, [loadCacheStatus]);

  // 1. Identify parts with Manufacturer Part Numbers (MFN) — those are what the APIs can price.
  const mfnItems = useMemo(() => {
    return items.filter(item => {
      const hasMfn = item.manPns && item.manPns.length > 0 &&
        item.manPns.some(pn => pn && pn !== 'N/A' && pn !== 'N' && pn.trim() !== '');
      return hasMfn;
    });
  }, [items]);

  // 2. Classify each part's likely supplier (Mouser first, then DigiKey, then LCSC).
  const classifiedItems = useMemo(() => {
    const scored = mfnItems.map(item => {
      const hasMouserLink = item.weblinks && item.weblinks.some(link => link.toLowerCase().includes('mouser'));
      const isMouserSupplier = item.supplier?.toLowerCase().includes('mouser');
      const hasMouserPnPattern = item.manPns && item.manPns.some(pn => pn.startsWith('611-') || pn.startsWith('603-') || pn.startsWith('647-') || pn.startsWith('581-') || pn.startsWith('356-'));
      const isMouser = !!(hasMouserLink || isMouserSupplier || hasMouserPnPattern);

      const hasDigiKeyLink = item.weblinks && item.weblinks.some(link => link.toLowerCase().includes('digikey'));
      const isDigiKeySupplier = item.supplier?.toLowerCase().includes('digikey');
      const hasDigiKeyPnPattern = (item.supPns && item.supPns.some(pn => pn.endsWith('-ND'))) || (item.manPns && item.manPns.some(pn => pn.includes('-ND')));
      const isDigiKey = !!(hasDigiKeyLink || isDigiKeySupplier || hasDigiKeyPnPattern);

      const hasLcscLink = item.weblinks && item.weblinks.some(link => link.toLowerCase().includes('lcsc'));
      const isLcscSupplier = item.supplier?.toLowerCase().includes('lcsc');
      const hasLcscPnPattern = item.manPns && item.manPns.some(pn => pn.startsWith('C') && pn.length > 3 && !isNaN(Number(pn.substring(1, 6))));
      const isLcsc = !!(hasLcscLink || isLcscSupplier || hasLcscPnPattern);

      const targetSupplier = isMouser
        ? 'Mouser Electronics'
        : isDigiKey
          ? 'DigiKey Marketplace'
          : isLcsc
            ? 'LCSC Electronics'
            : item.supplier || 'Generic Supplier';

      const score = isMouser ? 3 : isDigiKey ? 2 : isLcsc ? 1 : 0;

      return {
        item,
        isMouser,
        isDigiKey,
        isLcsc,
        supplierName: targetSupplier,
        mfnPn: item.manPns?.find(pn => pn && pn !== 'N/A' && pn.trim() !== '') || 'N/A',
        score
      };
    });

    return scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : (a.item.partNumber || '').localeCompare(b.item.partNumber || '')));
  }, [mfnItems]);

  // Parts whose price is still inside the cache window. Hidden by default so the
  // list only shows work that actually needs doing.
  const isCachedFresh = React.useCallback(
    (mfnPn: string) => Boolean(cachedMfns[mfnPn]) && !fetched[mfnPn],
    [cachedMfns, fetched]
  );

  const filteredClassified = useMemo(() => {
    const cleanSearch = searchTerm.toLowerCase().trim();
    const bySearch = !cleanSearch ? classifiedItems : classifiedItems.filter(entry =>
      (entry.item.partNumber || '').toLowerCase().includes(cleanSearch) ||
      (entry.item.name || '').toLowerCase().includes(cleanSearch) ||
      entry.mfnPn.toLowerCase().includes(cleanSearch) ||
      entry.supplierName.toLowerCase().includes(cleanSearch)
    );
    if (showCached) return bySearch;
    // Keep a row visible if it was priced in this session, so results stay on
    // screen after a query instead of vanishing as soon as they are cached.
    return bySearch.filter(e => !cachedMfns[e.mfnPn] || fetched[e.item.partNumber]);
  }, [classifiedItems, searchTerm, showCached, cachedMfns, fetched]);

  const cachedHiddenCount = useMemo(
    () => classifiedItems.filter(e => cachedMfns[e.mfnPn] && !fetched[e.item.partNumber]).length,
    [classifiedItems, cachedMfns, fetched]
  );

  const selectedCount = useMemo(() => Object.keys(selectedItems).filter(k => selectedItems[k]).length, [selectedItems]);

  // Live query: fetch real supplier pricing for the selected rows (or the filtered set if none
  // are selected). Sequential + capped, to stay within the 1,000/day per-API limit.
  const handleQueryCatalog = async () => {
    const selectedEntries = classifiedItems.filter(e => selectedItems[e.item.partNumber]);
    const targets = selectedEntries.length ? selectedEntries : filteredClassified;
    if (!targets.length) {
      onShowNotification('No components with manufacturer part numbers to price.');
      return;
    }
    if (!selectedEntries.length && targets.length > 15) {
      const ok = window.confirm(`Query live prices for ${targets.length} parts? This uses up to ${targets.length * 2} of your daily supplier API calls. Tip: tick specific rows first to query only those.`);
      if (!ok) return;
    }

    setIsQuerying(true);
    setProgress({ done: 0, total: targets.length, current: '' });
    const next: Record<string, FetchedPrice> = { ...fetched };

    for (let i = 0; i < targets.length; i++) {
      const entry = targets[i];
      setProgress({ done: i, total: targets.length, current: entry.item.partNumber });
      try {
        // 30-day window: a part priced recently is served from cache and costs
        // no supplier API call.
        const res = await fetch(`/api/pricing/search?partNumber=${encodeURIComponent(entry.mfnPn)}&qty=${targetQty}&maxAgeDays=${CACHE_DAYS}`);
        const data = await res.json();
        next[entry.item.partNumber] = pickProviderPrice(entry, data);
      } catch {
        next[entry.item.partNumber] = { price: null, currency: null, provider: null, breakQty: null, error: 'Request failed' };
      }
      if (next[entry.item.partNumber].price != null) {
        setSelectedItems(prev => ({ ...prev, [entry.item.partNumber]: true }));
      }
      setFetched({ ...next });
    }

    setProgress({ done: targets.length, total: targets.length, current: '' });
    setIsQuerying(false);
    // Newly cached parts drop out of the list on the next load of this status.
    await loadCacheStatus();
    const priced = targets.filter(t => next[t.item.partNumber]?.price != null).length;
    onShowNotification(`Live pricing complete — ${priced} of ${targets.length} parts priced from Mouser / DigiKey / LCSC. Cached for ${CACHE_DAYS} days.`);
  };

  const handleApplySelectedBulkPrices = () => {
    const updates: { partNumber: string; price: number }[] = [];
    classifiedItems.forEach(entry => {
      const pn = entry.item.partNumber;
      const f = fetched[pn];
      if (selectedItems[pn] && f && f.price != null) updates.push({ partNumber: pn, price: f.price });
    });

    if (updates.length === 0) {
      onShowNotification('No live prices to apply — query the catalog first, then select priced rows.');
      return;
    }
    // The parent handler persists to the DB and raises its own success/failure toast, so we
    // don't pre-announce success here (that would contradict a failed save).
    onUpdatePrices(updates);
  };

  const toggleSelectItem = (partNumber: string) => setSelectedItems(prev => ({ ...prev, [partNumber]: !prev[partNumber] }));

  const toggleSelectAll = () => {
    const allSelected = filteredClassified.length > 0 && filteredClassified.every(entry => selectedItems[entry.item.partNumber]);
    const nextState: Record<string, boolean> = { ...selectedItems };
    filteredClassified.forEach(entry => { nextState[entry.item.partNumber] = !allSelected; });
    setSelectedItems(nextState);
  };

  const progressPercent = progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100);
  const pricedCount = useMemo(() => Object.values(fetched).filter(f => f.price != null).length, [fetched]);

  return (
    <div className="bg-surface-container rounded-xl border border-outline-variant overflow-hidden" id="bulk-pricing-wizard-container">
      {/* Header */}
      <div className="p-lg border-b border-outline-variant bg-surface-container-high/20 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-md">
        <div>
          <div className="flex items-center gap-xs text-primary mb-1">
            <Sparkles className="w-4 h-4" />
            <span className="font-label-caps text-[10px] tracking-wider font-extrabold uppercase text-primary">Procurement Optimisation</span>
          </div>
          <h4 className="text-base font-bold text-on-surface">Live Wholesale Bulk Pricing</h4>
          <p className="text-xs text-on-surface-variant max-w-[672px] mt-0.5 leading-relaxed">
            Pulls live unit pricing at your target quantity from Mouser, DigiKey and LCSC for each part's manufacturer number.
            Select rows to price just those, or query the whole filtered list. <span className="font-semibold text-primary">Stock levels are never changed.</span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-sm shrink-0">
          <label className="flex items-center gap-1 text-[11px] text-on-surface-variant font-medium">
            Qty
            <select
              value={targetQty}
              onChange={(e) => setTargetQty(Number(e.target.value))}
              disabled={isQuerying}
              className="bg-surface-container-high border border-outline-variant rounded px-2 py-1 text-xs text-on-surface outline-none focus:border-primary disabled:opacity-50"
            >
              {QTY_OPTIONS.map(q => <option key={q} value={q}>{q.toLocaleString()}</option>)}
            </select>
          </label>

          <button
            type="button"
            disabled={isQuerying}
            onClick={handleQueryCatalog}
            className="bg-surface-container-highest hover:bg-surface-container-highest/80 border border-outline-variant px-md py-2 rounded text-xs font-bold text-on-surface transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isQuerying ? 'animate-spin text-primary' : ''}`} />
            {isQuerying ? 'Querying APIs...' : selectedCount > 0 ? `Query ${selectedCount} selected` : 'Query wholesale catalog'}
          </button>

          <button
            type="button"
            disabled={isQuerying || pricedCount === 0}
            onClick={handleApplySelectedBulkPrices}
            className="bg-primary text-on-primary hover:brightness-110 px-lg py-2 rounded text-xs font-extrabold transition-all uppercase tracking-wider shadow shadow-primary/10 flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            <Check className="w-3.5 h-3.5" />
            Apply live rates
          </button>
        </div>
      </div>

      {/* Progress bar */}
      {isQuerying && (
        <div className="bg-primary/5 px-lg py-sm border-b border-outline-variant flex items-center justify-between gap-md text-xs font-mono">
          <div className="flex items-center gap-sm text-primary w-full max-w-[448px]">
            <RefreshCw className="w-4 h-4 animate-spin text-primary shrink-0" />
            <div className="w-full">
              <span className="block font-semibold mb-0.5">Querying supplier APIs: {progress.current}</span>
              <div className="w-full bg-outline-variant/30 h-1.5 rounded-full overflow-hidden">
                <div className="bg-primary h-full transition-all duration-150" style={{ width: `${progressPercent}%` }} role="progressbar" aria-label={`Query progress: ${progressPercent}%`} aria-valuenow={progressPercent} {...{ 'aria-valuemin': 0, 'aria-valuemax': 100 }}></div>
              </div>
            </div>
          </div>
          <span className="text-outline text-[11px] shrink-0">{progress.done} / {progress.total} parts queried</span>
        </div>
      )}

      {/* Control row */}
      <div className="p-md bg-surface-container-low/60 border-b border-outline-variant/50 flex flex-col sm:flex-row justify-between items-center gap-2.5">
        <div className="relative w-full sm:max-w-[320px]">
          <Search className="absolute left-sm top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-outline" />
          <input
            type="text"
            placeholder="Search manufacturers, Mouser, DigiKey & LCSC parts..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-lg pr-sm py-1.5 bg-surface-container-high border border-outline-variant rounded-lg text-xs outline-none focus:border-primary transition-all text-on-surface"
          />
        </div>

        {/* Cached parts are hidden rather than silently dropped — say how many
            and let the list be opened up again. */}
        {cachedHiddenCount > 0 && (
          <div className="flex items-center gap-2 text-[10px] text-on-surface-variant/70 -mt-1">
            <span>
              {cachedHiddenCount} part{cachedHiddenCount === 1 ? '' : 's'} hidden — priced within the last {CACHE_DAYS} days
              {showCached ? ' (shown)' : ''}
            </span>
            <button
              type="button"
              onClick={() => setShowCached(v => !v)}
              className="px-1.5 py-0.5 rounded border border-outline-variant hover:border-primary hover:text-primary transition-colors"
            >
              {showCached ? 'Hide cached' : 'Show cached'}
            </button>
          </div>
        )}

        <div className="bg-primary/5 border border-primary/20 text-primary text-[11px] rounded-lg px-2.5 py-1.5 flex items-center gap-1.5">
          <Lock className="w-3.5 h-3.5 text-primary shrink-0" />
          <span><b>Stock protected</b>: only pricing is updated when you apply live rates.</span>
        </div>
      </div>

      {/* Parts table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse" id="bulk-pricing-table">
          <thead>
            <tr className="bg-surface-container-high font-label-caps text-[10px] text-outline border-b border-outline-variant">
              <th className="px-lg py-sm w-12 text-center">
                <input
                  type="checkbox"
                  checked={filteredClassified.length > 0 && filteredClassified.every(entry => selectedItems[entry.item.partNumber])}
                  onChange={toggleSelectAll}
                  aria-label="Select all listed components for live pricing"
                  className="rounded border-outline cursor-pointer accent-primary"
                />
              </th>
              <th className="px-lg py-sm">Product specification & MFN</th>
              <th className="px-lg py-sm">Priced via</th>
              <th className="px-lg py-sm text-right">Protected Qty</th>
              <th className="px-lg py-sm text-right">Base unit price</th>
              <th className="px-lg py-sm text-center">Change</th>
              <th className="px-lg py-sm text-right">Live price @ {targetQty.toLocaleString()}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-outline-variant/30 text-xs text-on-surface">
            {filteredClassified.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-lg py-lg text-center text-outline font-mono text-xs">
                  No components with manufacturer parts matched the filters.
                </td>
              </tr>
            ) : (
              filteredClassified.map(({ item, isMouser, isDigiKey, isLcsc, supplierName, mfnPn }) => {
                const currentPrice = item.price;
                const f = fetched[item.partNumber];
                const isRowQuerying = isQuerying && progress.current === item.partNumber;
                const priceDiffPercent = f?.price != null && currentPrice ? ((f.price - currentPrice) / currentPrice) * 100 : null;

                const rowBgClass = isMouser
                  ? 'bg-primary/5 border-l-2 border-primary/40'
                  : isDigiKey
                    ? 'bg-amber-500/5 border-l-2 border-amber-500/40'
                    : isLcsc
                      ? 'bg-cyan-500/5 border-l-2 border-cyan-500/40'
                      : '';

                return (
                  <tr
                    key={item.partNumber}
                    className={`hover:bg-surface-variant/10 transition-all duration-150 ${rowBgClass}`}
                    onClick={() => toggleSelectItem(item.partNumber)}
                  >
                    <td className="px-lg py-sm text-center" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={!!selectedItems[item.partNumber]}
                        onChange={() => toggleSelectItem(item.partNumber)}
                        aria-label={`Select component spec ${item.partNumber} (${item.name})`}
                        className="rounded border-outline cursor-pointer accent-primary"
                      />
                    </td>
                    <td className="px-lg py-sm">
                      <div className="font-bold text-on-surface flex flex-wrap items-center gap-xs">
                        <span>{item.name}</span>
                        {isMouser && <span className="bg-primary/10 border border-primary/20 text-primary text-[9px] font-mono px-1.5 py-0.5 rounded uppercase font-extrabold tracking-wider shrink-0">Mouser</span>}
                        {isDigiKey && <span className="bg-amber-500/10 border border-amber-500/20 text-amber-500 text-[9px] font-mono px-1.5 py-0.5 rounded uppercase font-extrabold tracking-wider shrink-0">DigiKey</span>}
                        {isLcsc && <span className="bg-cyan-500/10 border border-cyan-500/20 text-cyan-500 text-[9px] font-mono px-1.5 py-0.5 rounded uppercase font-extrabold tracking-wider shrink-0">LCSC</span>}
                      </div>
                      <span className="text-[10px] text-outline block font-mono">
                        {item.partNumber} &bull; MFN: <span className="font-bold text-on-surface-variant">{mfnPn}</span>
                      </span>
                    </td>
                    <td className="px-lg py-sm">
                      <span className="bg-surface-container-high border border-outline-variant px-2 py-0.5 rounded text-[11px] font-medium text-on-surface-variant">
                        {f?.provider || supplierName}
                      </span>
                    </td>
                    <td className="px-lg py-sm text-right font-mono text-[11px] font-bold text-on-surface-variant">
                      <div className="inline-flex items-center gap-1 bg-surface-container-high/40 border border-outline-variant/30 px-2 py-0.5 rounded-lg select-none">
                        <Lock className="w-2.5 h-2.5 text-outline shrink-0" />
                        <span>{item.stockLevel.toLocaleString()}</span>
                      </div>
                    </td>
                    <td className="px-lg py-sm font-mono text-right text-outline">
                      ${currentPrice.toFixed(3)}
                    </td>
                    <td className="px-lg py-sm text-center">
                      {priceDiffPercent === null ? (
                        <span className="text-outline text-[11px]">—</span>
                      ) : (
                        <span className={`inline-flex items-center gap-1 font-bold font-mono text-[11px] ${priceDiffPercent <= 0 ? 'text-green-400' : 'text-tertiary'}`}>
                          <TrendingDown className={`w-3 h-3 shrink-0 ${priceDiffPercent > 0 ? 'rotate-180' : ''}`} />
                          {priceDiffPercent > 0 ? '+' : ''}{priceDiffPercent.toFixed(1)}%
                        </span>
                      )}
                    </td>
                    <td className="px-lg py-sm font-mono text-right text-sm">
                      {isRowQuerying ? (
                        <span className="inline-flex items-center gap-1 text-primary"><Loader2 className="w-3 h-3 animate-spin" /> …</span>
                      ) : f?.price != null ? (
                        <div className="flex items-center justify-end gap-1 text-primary font-bold">
                          <ArrowRight className="w-2.5 h-2.5 text-outline shrink-0 mr-1" />
                          <span>{f.currency ? `${f.currency} ` : ''}{f.price.toFixed(3)}</span>
                          {f.breakQty ? <span className="text-[9px] text-outline font-normal ml-1">@{Number(f.breakQty).toLocaleString()}</span> : null}
                        </div>
                      ) : f?.error ? (
                        <span className="inline-flex items-center gap-1 text-outline text-[10px] font-normal" title={f.error}><AlertCircle className="w-3 h-3 shrink-0" /> {f.error}</span>
                      ) : (
                        isCachedFresh(mfnPn) ? (
                          <span
                            className="text-[10px] text-green-400/80"
                            title={`Priced ${cachedMfns[mfnPn].ageDays.toFixed(1)} days ago — re-queried after ${CACHE_DAYS} days`}
                          >
                            cached {Math.round(cachedMfns[mfnPn].ageDays)}d ago
                          </span>
                        ) : <span className="text-outline text-[11px]">not queried</span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
