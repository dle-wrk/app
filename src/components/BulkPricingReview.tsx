// Review of bulk pricing problems: the items whose last result was held back,
// got no price, or failed. Pick one to see every supplier's answer side by
// side with the current price, then approve a price, keep the current one,
// set one by hand, ask the suppliers again, or leave the item out of bulk
// pricing. Server: src/lib/bulkPricingReview.ts.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, ChevronLeft, ChevronRight, ExternalLink, Loader2, RefreshCw, ShieldOff, X } from 'lucide-react';
import { confirmDialog } from '../lib/confirmDialog';
import { fmtCurrency, fmtNumber } from '../lib/formatMoney';
import { currentUserCan, notAllowedMessage } from '../lib/permissions';
import { inputClass, PrimaryButton, SecondaryButton } from './bookkeeping/shared';

type ProblemKind = 'flagged' | 'no_price' | 'failed';
type ToastType = 'SUCCESS' | 'ERROR' | 'INFO';

export interface QuoteAnswer {
  provider: string;
  matchedPart: string | null;
  manufacturer: string | null;
  nativePrice: number | null;
  currency: string | null;
  zar: number | null;
  usd: number | null;
  stock: number | null;
  breakQty: number | null;
  url: string | null;
  error: string | null;
}

export interface ReviewEntry {
  serialNumber: string;
  name: string | null;
  partNumber: string | null;
  lcscCode: string | null;
  bulkPriceZar: number | null;
  bulkPriceUsd: number | null;
  problem: ProblemKind;
  reason: string | null;
  lastAttemptAt: string | null;
  result: null | {
    historyId: number;
    status: string;
    at: string | null;
    runId: number | null;
    recheck: boolean;
    preview: boolean;
    decidedBy: string | null;
    provider: string | null;
    matchedPart: string | null;
    proposedZar: number | null;
    proposedUsd: number | null;
    reason: string | null;
    answers: QuoteAnswer[] | null;
  };
}

interface Props {
  onShowNotification: (msg: string, type?: ToastType) => void;
  /** Called after a decision, so the page reloads its lists (and the app its inventory when a price changed). */
  onDecided?: (priceChanged: boolean) => void;
  /** Opens an item's detail, to edit its part numbers. */
  onOpenItem?: (serialNumber: string) => void;
  /** Bumped by the page when bulk pricing changed elsewhere (a run, another person). */
  refreshKey?: number;
}

const KINDS: Array<{ value: 'all' | ProblemKind; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'flagged', label: 'Held back' },
  { value: 'no_price', label: 'No price' },
  { value: 'failed', label: 'Failed' },
];
const PROBLEM: Record<ProblemKind, { label: string; className: string }> = {
  flagged: { label: 'Held back', className: 'bg-amber-500/10 text-amber-500 border-amber-500/25' },
  no_price: { label: 'No price', className: 'bg-amber-500/10 text-amber-500 border-amber-500/25' },
  failed: { label: 'Failed', className: 'bg-error/10 text-error border-error/20' },
};
const PROVIDER: Record<string, string> = { digikey: 'DigiKey', mouser: 'Mouser', lcsc: 'LCSC', nexar: 'Nexar', element14: 'element14', tme: 'TME' };

const dp = (n: number) => (Math.abs(n) < 10 ? 4 : 2);
const zarText = (n: number | null) => (n === null ? '—' : fmtCurrency(n, 'ZAR', dp(n)));
const usdText = (n: number | null) => (n === null ? '—' : fmtCurrency(n, 'USD', dp(n)));
const nativeText = (a: QuoteAnswer) => (a.nativePrice === null || !a.currency ? '—'
  : ['ZAR', 'USD', 'EUR', 'GBP'].includes(a.currency) ? fmtCurrency(a.nativePrice, a.currency, dp(a.nativePrice)) : `${fmtNumber(a.nativePrice, dp(a.nativePrice))} ${a.currency}`);
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

function versus(current: number | null, candidate: number | null): { text: string; className: string } | null {
  if (current === null || candidate === null || current <= 0) return null;
  const ratio = candidate / current;
  const pct = Math.round((ratio - 1) * 100);
  const text = ratio >= 10 ? `×${fmtNumber(ratio, 0)}` : `${pct > 0 ? '+' : ''}${pct}%`;
  return { text, className: Math.abs(pct) >= 50 ? 'text-amber-500 font-bold' : 'text-on-surface-variant' };
}

const Pill: React.FC<{ kind: ProblemKind }> = ({ kind }) => (
  <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-bold border whitespace-nowrap ${PROBLEM[kind].className}`}>{PROBLEM[kind].label}</span>
);

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

export default function BulkPricingReview({ onShowNotification, onDecided, onOpenItem, refreshKey = 0 }: Props) {
  const canDecide = currentUserCan('inventory.update');
  const [kind, setKind] = useState<'all' | ProblemKind>('all');
  const [entries, setEntries] = useState<ReviewEntry[] | null>(null);
  const [counts, setCounts] = useState<Record<'all' | ProblemKind, number>>({ all: 0, flagged: 0, no_price: 0, failed: 0 });
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [manual, setManual] = useState<string>('');
  const [showManual, setShowManual] = useState(false);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/pricing/bulk-review${kind === 'all' ? '' : `?kind=${kind}`}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error || 'Could not load the problems.'); return; }
      setEntries(data.entries ?? []);
      setCounts(data.counts ?? { all: 0, flagged: 0, no_price: 0, failed: 0 });
      setError(null);
    } catch (err: any) {
      setError(`Could not load the problems: ${err?.message || err}`);
    }
  }, [kind]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  // Keep a valid selection: the first item when none (or the selected one went).
  useEffect(() => {
    if (!entries) return;
    if (!selected || !entries.some((e) => e.serialNumber === selected)) setSelected(entries[0]?.serialNumber ?? null);
  }, [entries, selected]);

  const index = entries ? entries.findIndex((e) => e.serialNumber === selected) : -1;
  const entry = index >= 0 ? entries![index] : null;
  useEffect(() => { setShowManual(false); setManual(''); setNote(''); }, [selected]);

  const answers = useMemo(() => {
    const list = entry?.result?.answers ?? [];
    // Priced answers first, cheapest first; then the ones without a price.
    return [...list].sort((a, b) => (a.zar === null ? 1 : 0) - (b.zar === null ? 1 : 0) || (a.zar ?? 0) - (b.zar ?? 0));
  }, [entry]);
  const cheapest = answers.find((a) => a.zar !== null) ?? null;

  const step = (delta: number) => {
    if (!entries?.length) return;
    const next = entries[Math.min(entries.length - 1, Math.max(0, index + delta))];
    setSelected(next.serialNumber);
  };

  const afterDecision = async (serial: string, message: string, priceChanged: boolean) => {
    onShowNotification(message, 'SUCCESS');
    // Move on to the next item, then reload.
    if (entries) {
      const i = entries.findIndex((e) => e.serialNumber === serial);
      const next = entries[i + 1] ?? entries[i - 1] ?? null;
      setSelected(next?.serialNumber ?? null);
    }
    onDecided?.(priceChanged);
    await load();
  };

  const act = async (key: string, run: () => Promise<void>) => {
    setBusy(key);
    try { await run(); } catch (err: any) {
      onShowNotification(`That didn't work: ${err?.message || err}`, 'ERROR');
    } finally { setBusy(null); }
  };

  const approve = (answer: QuoteAnswer) => act(`approve:${answer.provider}`, async () => {
    if (!entry?.result) return;
    const ok = await confirmDialog({
      title: 'Approve this price',
      message: `Set ${entry.serialNumber}'s bulk price to ${zarText(answer.zar)} (${usdText(answer.usd)}) from ${PROVIDER[answer.provider] ?? answer.provider}`
        + `${answer.matchedPart ? `, which matched ${answer.matchedPart}` : ''}?\n\nIt is now ${zarText(entry.bulkPriceZar)}.`,
      confirmLabel: 'Approve price',
    });
    if (!ok) return;
    const { ok: done, data } = await post(`/api/pricing/bulk-review/${encodeURIComponent(entry.serialNumber)}/approve`, { historyId: entry.result.historyId, provider: answer.provider });
    if (!done) { onShowNotification(data.error || 'Could not approve the price.', 'ERROR'); if (/newer result/.test(data.error ?? '')) await load(); return; }
    await afterDecision(entry.serialNumber, `${entry.serialNumber}: bulk price set to ${zarText(data.newPriceZar)} from ${PROVIDER[answer.provider] ?? answer.provider}.`, !!data.changed);
  });

  const keep = () => act('reject', async () => {
    if (!entry) return;
    const { ok, data } = await post(`/api/pricing/bulk-review/${encodeURIComponent(entry.serialNumber)}/reject`, { note });
    if (!ok) { onShowNotification(data.error || 'Could not record that.', 'ERROR'); return; }
    await afterDecision(entry.serialNumber, `${entry.serialNumber}: kept the current price${entry.bulkPriceZar !== null ? ` (${zarText(entry.bulkPriceZar)})` : ''}.`, false);
  });

  const setByHand = () => act('manual', async () => {
    if (!entry) return;
    const zar = Number(manual.replace(',', '.'));
    if (!Number.isFinite(zar) || zar <= 0) { onShowNotification('Enter a price in rand above 0.', 'ERROR'); return; }
    const { ok, data } = await post(`/api/pricing/bulk-review/${encodeURIComponent(entry.serialNumber)}/price`, { zar });
    if (!ok) { onShowNotification(data.error || 'Could not set the price.', 'ERROR'); return; }
    await afterDecision(entry.serialNumber, `${entry.serialNumber}: bulk price set by hand to ${zarText(data.newPriceZar)} (${usdText(data.newPriceUsd)}).`, !!data.changed);
  });

  const recheck = () => act('recheck', async () => {
    if (!entry) return;
    const { ok, data } = await post(`/api/pricing/bulk-review/${encodeURIComponent(entry.serialNumber)}/recheck`, {});
    if (!ok) { onShowNotification(data.error || 'Could not ask the suppliers.', 'ERROR'); return; }
    onShowNotification(`${entry.serialNumber}: suppliers asked again. Compare their answers below.`, 'INFO');
    if (data.entry) setEntries((list) => (list ?? []).map((e) => (e.serialNumber === data.entry.serialNumber ? data.entry : e)));
  });

  const exclude = () => act('exclude', async () => {
    if (!entry) return;
    const ok = await confirmDialog({
      title: 'Leave out of bulk pricing',
      message: `Leave ${entry.serialNumber} out of bulk pricing?\n\nRuns and the daily automatic run skip it (unless you tick it), and it leaves the problem list. Its current price stays. You can put it back from the "Excluded" filter below.`,
      confirmLabel: 'Leave it out',
    });
    if (!ok) return;
    const { ok: done, data } = await post(`/api/pricing/bulk-review/${encodeURIComponent(entry.serialNumber)}/exclude`, { excluded: true });
    if (!done) { onShowNotification(data.error || 'Could not leave it out.', 'ERROR'); return; }
    await afterDecision(entry.serialNumber, `${entry.serialNumber} is left out of bulk pricing.`, false);
  });

  if (entries && counts.all === 0 && kind === 'all') return null;

  return (
    <div className="bg-surface-container rounded-xl border border-amber-500/30 overflow-hidden" data-testid="bulk-review">
      <div className="px-lg py-sm border-b border-outline-variant bg-amber-500/5 flex flex-wrap items-center justify-between gap-sm">
        <div className="flex items-center gap-sm">
          <AlertTriangle className="w-4 h-4 text-amber-500" />
          <span className="font-bold text-sm">Problems to review</span>
          <span className="text-[11px] font-bold text-amber-500 bg-amber-500/10 px-2 py-0.5 rounded">{fmtNumber(counts.all)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-xs" role="group" aria-label="Show problems">
          {KINDS.map((k) => (
            <button key={k.value} type="button" aria-pressed={kind === k.value} onClick={() => setKind(k.value)}
              className={`px-2.5 py-1 rounded-full text-[11px] font-bold border ${kind === k.value ? 'bg-amber-500/15 text-amber-500 border-amber-500/40' : 'border-outline-variant text-on-surface-variant hover:border-amber-500/40'}`}>
              {k.label} ({fmtNumber(counts[k.value])})
            </button>
          ))}
          <button type="button" onClick={() => void load()} aria-label="Reload problems" className="ml-1 text-on-surface-variant hover:text-primary"><RefreshCw className="w-3.5 h-3.5" /></button>
        </div>
      </div>

      {!canDecide && <p className="px-lg pt-sm text-[11px] text-outline">{notAllowedMessage('inventory.update')} You can compare the answers.</p>}
      {error && <p className="px-lg pt-sm text-xs text-error">{error}</p>}
      {!entries && !error && <p className="px-lg py-md text-xs text-outline"><Loader2 className="w-3.5 h-3.5 animate-spin inline-block mr-1" />Loading…</p>}
      {entries && entries.length === 0 && <p className="px-lg py-md text-xs text-outline italic">None of this kind.</p>}

      {entries && entries.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr]">
          {/* The queue */}
          <ul className="border-b lg:border-b-0 lg:border-r border-outline-variant max-h-[520px] overflow-y-auto" aria-label="Problem items" data-testid="review-queue">
            {entries.map((e) => (
              <li key={e.serialNumber}>
                <button type="button" onClick={() => setSelected(e.serialNumber)} aria-current={e.serialNumber === selected}
                  className={`w-full text-left px-md py-sm border-b border-outline-variant/30 hover:bg-surface-variant/10 ${e.serialNumber === selected ? 'bg-amber-500/10' : ''}`}>
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-mono font-bold text-xs truncate">{e.serialNumber}</span>
                    <Pill kind={e.problem} />
                  </span>
                  <span className="block text-[11px] text-on-surface-variant truncate">{e.name}</span>
                  {e.problem === 'flagged' && e.result?.proposedZar !== null && e.result?.proposedZar !== undefined && (
                    <span className="block text-[10px] text-outline">{zarText(e.bulkPriceZar)} → {zarText(e.result.proposedZar)}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>

          {/* The selected item */}
          {entry && (
            <div className="p-lg space-y-md min-w-0" data-testid="review-detail">
              <div className="flex flex-wrap items-start justify-between gap-sm">
                <div className="min-w-0">
                  <div className="flex items-center gap-sm flex-wrap">
                    <span className="font-mono font-bold text-sm">{entry.serialNumber}</span>
                    <Pill kind={entry.problem} />
                    {onOpenItem && (
                      <button type="button" onClick={() => onOpenItem(entry.serialNumber)} className="text-[11px] text-primary hover:underline">Open item / edit part numbers</button>
                    )}
                  </div>
                  <p className="text-xs text-on-surface-variant">{entry.name}</p>
                  <p className="text-[11px] text-outline mt-0.5">
                    Looked up as <span className="font-mono text-on-surface">{entry.partNumber ?? '—'}</span>
                    {entry.lcscCode && entry.lcscCode !== entry.partNumber && <> · LCSC <span className="font-mono text-on-surface">{entry.lcscCode}</span></>}
                  </p>
                </div>
                <div className="flex items-center gap-xs text-[11px] text-on-surface-variant">
                  <button type="button" aria-label="Previous item" disabled={index <= 0} onClick={() => step(-1)} className="p-1 rounded border border-outline-variant disabled:opacity-40"><ChevronLeft className="w-3.5 h-3.5" /></button>
                  <span>{fmtNumber(index + 1)} of {fmtNumber(entries.length)}</span>
                  <button type="button" aria-label="Next item" disabled={index >= entries.length - 1} onClick={() => step(1)} className="p-1 rounded border border-outline-variant disabled:opacity-40"><ChevronRight className="w-3.5 h-3.5" /></button>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-sm">
                <div className="rounded-lg border border-outline-variant bg-surface-container-low px-3 py-2">
                  <span className="block text-[10px] font-bold text-on-surface-variant">Current bulk price</span>
                  <span className="text-lg font-black font-mono" data-testid="current-price">{zarText(entry.bulkPriceZar)}</span>
                  <span className="text-[11px] text-outline ml-2">{usdText(entry.bulkPriceUsd)}</span>
                </div>
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                  <span className="block text-[10px] font-bold text-amber-500">What happened</span>
                  <span className="text-xs text-on-surface">{entry.result?.recheck ? (entry.result.reason ?? (entry.result.status === 'offer' ? 'Re-checked: the suppliers answered; compare below.' : 'Re-checked.')) : entry.reason ?? '—'}</span>
                  {entry.result && (
                    <span className="block text-[10px] text-outline mt-0.5">
                      {entry.result.recheck ? `Re-checked ${when(entry.result.at)}${entry.result.decidedBy ? ` by ${entry.result.decidedBy}` : ''}` : `Run ${entry.result.runId ? `#${entry.result.runId}` : ''}, ${when(entry.result.at)}`}
                    </span>
                  )}
                </div>
              </div>

              {/* Every supplier's answer */}
              <div>
                <span className="block text-[11px] font-bold text-on-surface-variant mb-1">What each supplier said</span>
                {entry.result?.answers ? (
                  <div className="overflow-x-auto border border-outline-variant/50 rounded-lg">
                    <table className="w-full text-left text-xs" data-testid="answers">
                      <thead className="bg-surface-container-high">
                        <tr className="text-[10px] text-outline uppercase tracking-wider">
                          <th className="px-md py-1.5">Supplier</th>
                          <th className="px-md py-1.5">Matched part</th>
                          <th className="px-md py-1.5 text-right">Their price</th>
                          <th className="px-md py-1.5 text-right">In rand</th>
                          <th className="px-md py-1.5 text-right">vs now</th>
                          <th className="px-md py-1.5 text-right">Stock</th>
                          <th className="px-md py-1.5"><span className="sr-only">Action</span></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-outline-variant/30">
                        {answers.map((a) => {
                          const vs = versus(entry.bulkPriceZar, a.zar);
                          const proposed = entry.result?.provider === a.provider && a.zar !== null;
                          return (
                            <tr key={a.provider} data-provider={a.provider} className={a === cheapest ? 'bg-primary/5' : ''}>
                              <td className="px-md py-1.5 font-bold whitespace-nowrap">
                                {PROVIDER[a.provider] ?? a.provider}
                                {a === cheapest && <span className="ml-1 text-[9px] font-bold text-primary uppercase">cheapest</span>}
                                {proposed && entry.problem === 'flagged' && !entry.result?.recheck && <span className="ml-1 text-[9px] font-bold text-amber-500 uppercase">held back</span>}
                              </td>
                              <td className="px-md py-1.5 font-mono text-[11px]">
                                {a.matchedPart ?? '—'}
                                {a.manufacturer && <span className="block font-sans text-[10px] text-outline">{a.manufacturer}</span>}
                                {a.url && <a href={a.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 font-sans text-[10px] text-secondary underline">listing <ExternalLink className="w-2.5 h-2.5" /></a>}
                              </td>
                              {a.zar === null ? (
                                <td colSpan={3} className="px-md py-1.5 text-[11px] text-outline">{a.nativePrice !== null ? `${nativeText(a)}: ` : ''}{a.error}</td>
                              ) : (
                                <>
                                  <td className="px-md py-1.5 text-right font-mono whitespace-nowrap">{nativeText(a)}{a.breakQty ? <span className="block text-[10px] text-outline">at {fmtNumber(a.breakQty)}+</span> : null}</td>
                                  <td className="px-md py-1.5 text-right font-mono whitespace-nowrap font-bold">{zarText(a.zar)}</td>
                                  <td className={`px-md py-1.5 text-right font-mono whitespace-nowrap ${vs?.className ?? 'text-outline'}`}>{vs?.text ?? '—'}</td>
                                </>
                              )}
                              <td className="px-md py-1.5 text-right font-mono">{a.stock !== null ? fmtNumber(a.stock) : '—'}</td>
                              <td className="px-md py-1.5 text-right">
                                {canDecide && a.zar !== null && (
                                  <SecondaryButton type="button" disabled={busy !== null} onClick={() => void approve(a)}
                                    icon={busy === `approve:${a.provider}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}>
                                    Use this price
                                  </SecondaryButton>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-xs text-outline">The suppliers' answers weren't kept for this result{canDecide ? '. Re-check now to see them side by side.' : '.'}</p>
                )}
              </div>

              {canDecide && (
                <div className="space-y-sm" data-testid="review-actions">
                  <div className="flex flex-wrap gap-sm">
                    <SecondaryButton type="button" disabled={busy !== null} onClick={() => void recheck()}
                      icon={busy === 'recheck' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}>
                      Re-check now
                    </SecondaryButton>
                    <SecondaryButton type="button" disabled={busy !== null} onClick={() => void keep()}
                      icon={busy === 'reject' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}>
                      Keep current price
                    </SecondaryButton>
                    <SecondaryButton type="button" disabled={busy !== null} onClick={() => setShowManual((v) => !v)} aria-expanded={showManual}>
                      Set price by hand
                    </SecondaryButton>
                    <SecondaryButton type="button" disabled={busy !== null} onClick={() => void exclude()}
                      icon={busy === 'exclude' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldOff className="w-3.5 h-3.5" />}>
                      Leave out of bulk pricing
                    </SecondaryButton>
                  </div>
                  <input type="text" aria-label="Reason (optional)" placeholder="Reason, kept with the decision (optional)" value={note}
                    onChange={(e) => setNote(e.target.value)} className={`${inputClass} py-1.5 text-xs max-w-[480px]`} />
                  {showManual && (
                    <div className="flex flex-wrap items-center gap-sm">
                      <label className="text-xs text-on-surface-variant" htmlFor="manual-price">Bulk price (R)</label>
                      {/* Text, not a number field: a number field drops "0,12" (comma decimals) silently. */}
                      <input id="manual-price" type="text" inputMode="decimal" placeholder="0.1234" value={manual} onChange={(e) => setManual(e.target.value)}
                        className={`${inputClass} py-1.5 text-xs w-[140px]`} />
                      <PrimaryButton type="button" disabled={busy !== null || !manual} onClick={() => void setByHand()}
                        icon={busy === 'manual' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : undefined}>
                        Save price
                      </PrimaryButton>
                      <span className="text-[11px] text-outline">Dollars are worked out at the stored rate.</span>
                    </div>
                  )}
                  <p className="text-[11px] text-outline">
                    A decision is recorded with your name and takes the item off this list until a later run finds a new problem.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
