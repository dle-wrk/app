// Order files: a BOM (BOM Audit) or the restock list as one upload file per
// supplier (Mouser, DigiKey, LCSC), using each item's supplier part numbers
// by slot. "Compare prices" prices every line at each supplier at the
// quantity (POST /api/supplier-quotes) and can split the order so each line
// goes to its cheapest supplier; a price can be clicked to choose another.
// Formats: ../lib/supplierBom; the cheapest choice: ../lib/supplierQuotes.

import { buildOrderSheets } from '../lib/orderWorkbook';
import { downloadWorkbook } from '../lib/xlsxDownload';
import React, { useEffect, useMemo, useState } from 'react';
import { Download, ShoppingCart, AlertTriangle, Scale, Loader2 } from 'lucide-react';
import { fmtCurrency, fmtNumber, fmtZAR } from '../lib/formatMoney';
import { canChange } from '../lib/changeAccess';
import type { SlotSupplier } from '../lib/partNumbers';
import { ORDER_SUPPLIERS, atNoSupplier, downloadCsv, orderCsv, supplierNumberFor, supplierOrders, type OrderLine } from '../lib/supplierBom';
import { isPriced, splitSummary, type LineQuotes } from '../lib/supplierQuotes';

export interface OrderFileLine extends Omit<OrderLine, 'qty'> {
  /** Needed for the whole build, and short of stock for it. */
  required: number;
  shortage: number;
}

interface QuotedLine { stockCode: string; qty: number; quotes: LineQuotes; best: SlotSupplier | null }
type QuoteState =
  | { status: 'idle' }
  | { status: 'running'; id: string; key: string; done: number; total: number }
  | { status: 'done'; key: string; lines: QuotedLine[] }
  | { status: 'error'; message: string };

const fileSafe = (s: string) => s.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'project';

export default function SupplierOrderFiles({ lines, projectName, pcbQty, onShowNotification, restock }: {
  lines: OrderFileLine[];
  projectName: string;
  pcbQty: number;
  onShowNotification: (msg: string, type?: 'SUCCESS' | 'ERROR' | 'INFO') => void;
  /** Restock: the quantities are the reorder suggestions (in `required`); no shortages/build choice. */
  restock?: { title: string; intro: string };
}) {
  const [basisChoice, setBasis] = useState<'shortage' | 'build'>('shortage');
  const basis = restock ? 'build' : basisChoice;
  const [showMissing, setShowMissing] = useState(false);
  const [quote, setQuote] = useState<QuoteState>({ status: 'idle' });
  const [picks, setPicks] = useState<Record<string, SlotSupplier>>({});
  const [split, setSplit] = useState(true);
  const [showPrices, setShowPrices] = useState(true);

  const qtyLines = useMemo(
    () => lines.map((l) => ({ ...l, qty: basis === 'shortage' ? l.shortage : l.required })).filter((l) => l.qty > 0),
    [lines, basis],
  );
  // Prices belong to these lines at these quantities: a change makes them stale.
  const key = useMemo(() => qtyLines.map((l) => `${l.stockCode}:${l.qty}:${(l.supPns ?? []).join('|')}`).join(','), [qtyLines]);
  const quoted = quote.status === 'done' && quote.key === key ? quote.lines : null;

  // Each line's supplier in a split: one picked, else the cheapest, else the first that lists it.
  const assignment = useMemo(() => {
    if (!quoted) return null;
    const byCode = new Map(quoted.map((q) => [q.stockCode, q]));
    const out: Record<string, SlotSupplier | null> = {};
    for (const l of qtyLines) {
      out[l.stockCode] = picks[l.stockCode] ?? byCode.get(l.stockCode)?.best
        ?? ORDER_SUPPLIERS.find(({ key: s }) => !!supplierNumberFor(l.supPns, s))?.key ?? null;
    }
    return out;
  }, [quoted, qtyLines, picks]);

  const splitOn = !!(quoted && split && assignment);
  // Once checked with the suppliers, each file orders what that supplier
  // can sell: its minimum and multiple (LCSC 0603 resistors in hundreds) and,
  // for DigiKey, cut tape instead of a reel number that needs a full reel.
  const checked = useMemo(() => {
    if (!quoted) return undefined;
    const byCode = new Map(quoted.map((q) => [q.stockCode, q]));
    return (code: string, s: SlotSupplier) => {
      const p = byCode.get(code)?.quotes[s];
      return isPriced(p) ? { supplierPn: p.supplierPn, qty: p.orderQty } : null;
    };
  }, [quoted]);
  const orders = useMemo(() => supplierOrders(qtyLines, splitOn ? assignment! : undefined, checked), [qtyLines, splitOn, assignment, checked]);
  const adjustments = useMemo(() => {
    let raised = 0, swapped = 0, noStock = 0;
    for (const q of quoted ?? []) for (const p of Object.values(q.quotes)) {
      if (!isPriced(p)) continue;
      if (p.orderQty > q.qty) raised++;
      if (p.swappedFrom) swapped++;
      if (!p.enoughStock) noStock++;
    }
    return { raised, swapped, noStock };
  }, [quoted]);
  const nowhere = atNoSupplier(supplierOrders(qtyLines));
  const summary = useMemo(() => (quoted && assignment
    ? splitSummary(quoted.map((q) => ({ quotes: q.quotes, choice: assignment[q.stockCode] ?? null })))
    : null), [quoted, assignment]);

  // Follow a running price check.
  useEffect(() => {
    if (quote.status !== 'running') return;
    const timer = window.setInterval(async () => {
      try {
        const res = await fetch(`/api/supplier-quotes/${quote.id}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { setQuote({ status: 'error', message: data.error || 'The price check stopped.' }); return; }
        if (data.finished) setQuote(data.error ? { status: 'error', message: data.error } : { status: 'done', key: quote.key, lines: data.lines });
        else setQuote((q) => (q.status === 'running' ? { ...q, done: data.done, total: data.total } : q));
      } catch { /* try again on the next tick */ }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [quote]);

  const comparePrices = async () => {
    const priceable = qtyLines.filter((l) => ORDER_SUPPLIERS.some(({ key: s }) => !!supplierNumberFor(l.supPns, s)));
    if (!priceable.length) { onShowNotification('No line has a Mouser, DigiKey or LCSC part number to price.', 'ERROR'); return; }
    setPicks({});
    setQuote({ status: 'running', id: '', key, done: 0, total: 0 });
    try {
      const res = await fetch('/api/supplier-quotes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines: priceable.map((l) => ({ stockCode: l.stockCode, supPns: l.supPns, qty: l.qty })) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setQuote({ status: 'error', message: data.error || 'Could not start the price check.' }); return; }
      setQuote({ status: 'running', id: data.id, key, done: 0, total: 0 });
    } catch (err: any) {
      setQuote({ status: 'error', message: err?.message || 'Could not start the price check.' });
    }
  };

  const download = (i: number) => {
    const o = orders[i];
    if (!o.rows.length) { onShowNotification(splitOn ? `No line is cheapest at ${o.label}.` : `No line has a ${o.label} part number.`, 'ERROR'); return; }
    const tag = splitOn ? '_cheapest' : '';
    const name = restock
      ? `${fileSafe(projectName)}_${o.supplier}${tag}_${new Date().toISOString().slice(0, 10)}.csv`
      : `${fileSafe(projectName)}_${o.supplier}${tag}_${basis === 'shortage' ? 'shortages' : 'build'}_${pcbQty}pcs.csv`;
    downloadCsv(name, orderCsv(o.supplier, o.rows));
    onShowNotification(`${o.label}: ${fmtNumber(o.rows.length)} lines written${!splitOn && o.missing.length ? `; ${fmtNumber(o.missing.length)} have no ${o.label} number` : ''}.`, 'SUCCESS');
  };

  const mayQuote = canChange('/api/supplier-quotes', 'POST');

  // Everything in one Excel file: Summary, a sheet per supplier, All lines, Not listed.
  const downloadAll = async () => {
    const stamp = new Date().toISOString().slice(0, 10);
    const what = restock ? 'restock' : basis === 'shortage' ? `shortages for ${pcbQty} pcs` : `whole build of ${pcbQty} pcs`;
    try {
      const sheets = buildOrderSheets({
        title: `${projectName}: ${what}`, date: stamp, lines: qtyLines, orders,
        quotes: quoted ? new Map(quoted.map((q) => [q.stockCode, q.quotes])) : null,
        assignment: splitOn ? assignment : null,
      });
      const name = restock
        ? `${fileSafe(projectName)}_orders${splitOn ? '_cheapest' : ''}_${stamp}.xlsx`
        : `${fileSafe(projectName)}_orders${splitOn ? '_cheapest' : ''}_${basis === 'shortage' ? 'shortages' : 'build'}_${pcbQty}pcs.xlsx`;
      await downloadWorkbook(sheets, name);
      onShowNotification(`Saved one workbook with ${sheets.length} sheets.`, 'SUCCESS');
    } catch (err: any) {
      onShowNotification(`Could not make the workbook: ${err?.message || err}`, 'ERROR');
    }
  };

  return (
    <div className="bg-surface-container border border-outline-variant rounded-xl p-md space-y-sm" data-testid="order-files">
      <div className="flex flex-wrap items-center justify-between gap-sm">
        <div>
          <h4 className="text-sm font-bold text-on-surface flex items-center gap-2"><ShoppingCart className="w-4 h-4 text-primary" /> {restock?.title ?? 'Order files'}</h4>
          <p className="text-[11px] text-on-surface-variant">{restock?.intro ?? "One file per supplier, ready to upload on their website: Mouser's BOM tool, DigiKey's BOM manager, LCSC's BOM tool. Part numbers come from Sup PN 1 Mouser, 2 DigiKey, 3 LCSC."}</p>
        </div>
        <div className="flex flex-wrap items-center gap-sm">
          {!restock && <div className="flex rounded-lg border border-outline-variant overflow-hidden text-[11px] font-bold" role="group" aria-label="Quantities">
            {([['shortage', 'Shortages only'], ['build', `Whole build (${fmtNumber(pcbQty)} pcs)`]] as const).map(([k, label]) => (
              <button key={k} type="button" onClick={() => setBasis(k)} aria-pressed={basis === k}
                className={`px-sm py-1 ${basis === k ? 'bg-primary text-white' : 'text-on-surface-variant hover:text-on-surface'}`}>{label}</button>
            ))}
          </div>}
          {mayQuote && qtyLines.length > 0 && (
            <button type="button" onClick={() => void comparePrices()} disabled={quote.status === 'running'}
              className="inline-flex items-center gap-1 px-sm py-1 rounded-lg border border-primary/40 text-primary text-[11px] font-bold hover:bg-primary/10 disabled:opacity-50">
              {quote.status === 'running' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Scale className="w-3.5 h-3.5" />}
              {quoted ? 'Compare again' : 'Compare prices'}
            </button>
          )}
        </div>
      </div>

      {quote.status === 'running' && (
        <p className="text-[11px] text-outline" data-testid="quote-progress">
          Asking the suppliers{quote.total ? `: ${fmtNumber(quote.done)} of ${fmtNumber(quote.total)} part numbers` : '…'} (Mouser allows 30 a minute; prices are kept for a day).
        </p>
      )}
      {quote.status === 'error' && <p className="text-[11px] text-error">The price check stopped: {quote.message}</p>}
      {qtyLines.length > 0 && !quoted && quote.status !== 'running' && (
        <p className="text-[11px] text-amber-500" data-testid="unchecked-note">
          These files order the shortage quantities as they are, not yet checked with the suppliers. LCSC sells many parts only in steps (0603 resistors in hundreds) and a DigiKey reel number (…-2-ND, …TR-ND) needs a full reel.
          {mayQuote ? ' Press Compare prices first: the files then use each supplier\'s minimum and pack size, and DigiKey cut tape where a reel would be needed.' : ''}
        </p>
      )}
      {quoted && (adjustments.raised > 0 || adjustments.swapped > 0 || adjustments.noStock > 0) && (
        <p className="text-[11px] text-on-surface-variant" data-testid="checked-note">
          Checked with the suppliers: the files order what each one sells.
          {adjustments.raised > 0 ? ` ${fmtNumber(adjustments.raised)} quantit${adjustments.raised === 1 ? 'y' : 'ies'} rounded up to a minimum or pack size.` : ''}
          {adjustments.swapped > 0 ? ` ${fmtNumber(adjustments.swapped)} DigiKey line${adjustments.swapped === 1 ? '' : 's'} switched to a packaging sold at this quantity (e.g. cut tape instead of reel).` : ''}
          {adjustments.noStock > 0 ? <span className="text-amber-500">{` ${fmtNumber(adjustments.noStock)} price${adjustments.noStock === 1 ? ' is' : 's are'} for stock the supplier doesn't have (shown in the table).`}</span> : ''}
        </p>
      )}

      {qtyLines.length === 0 ? (
        <p className="text-xs text-on-surface-variant">{restock ? 'Nothing needs reordering.' : basis === 'shortage' ? `Nothing is short for ${fmtNumber(pcbQty)} pcs: no order needed.` : 'This BOM has no lines to order.'}</p>
      ) : (
        <>
          {quoted && summary && (
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-sm space-y-1 text-[11px]" data-testid="price-summary">
              <div className="flex flex-wrap items-center justify-between gap-sm">
                <span className="text-on-surface">
                  <strong>{Object.keys(picks).length ? 'Your choice' : 'Cheapest per line'}: {fmtZAR(summary.totalZar)}</strong>
                  {ORDER_SUPPLIERS.filter(({ key: s }) => summary.bySupplier[s]).map(({ key: s, label }) => ` · ${label} ${fmtNumber(summary.bySupplier[s]!.lines)} lines ${fmtZAR(summary.bySupplier[s]!.totalZar)}`).join('')}
                  {summary.dearestZar > summary.totalZar ? <span className="text-green-500"> · {fmtZAR(summary.dearestZar - summary.totalZar)} less than the dearest quote on each line</span> : null}
                </span>
                <span className="flex rounded-lg border border-outline-variant overflow-hidden font-bold" role="group" aria-label="Files">
                  {([[true, 'Cheapest per line'], [false, 'Everything each supplier lists']] as const).map(([v, label]) => (
                    <button key={label} type="button" onClick={() => setSplit(v)} aria-pressed={split === v}
                      className={`px-sm py-0.5 ${split === v ? 'bg-primary text-white' : 'text-on-surface-variant hover:text-on-surface'}`}>{label}</button>
                  ))}
                </span>
              </div>
              <p className="text-outline">Rand at the daily rate, before shipping and import costs. {summary.unpriced ? `${fmtNumber(summary.unpriced)} ${summary.unpriced === 1 ? 'line has' : 'lines have'} no price and ${summary.unpriced === 1 ? 'goes' : 'go'} to the first supplier that lists ${summary.unpriced === 1 ? 'it' : 'them'}. ` : ''}Click a price below to buy that line there instead.</p>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-sm">
            {orders.map((o, i) => (
              <div key={o.supplier} className="rounded-lg border border-outline-variant bg-surface-container-high/40 p-sm flex items-center justify-between gap-sm">
                <div className="min-w-0">
                  <div className="text-xs font-bold text-on-surface">{i + 1}. {o.label}</div>
                  <div className="text-[10px] text-outline">
                    {fmtNumber(o.rows.length)} lines
                    {splitOn ? (summary?.bySupplier[o.supplier] ? ` · ${fmtZAR(summary.bySupplier[o.supplier]!.totalZar)}` : '') : o.missing.length ? ` · ${fmtNumber(o.missing.length)} not listed` : ''}
                  </div>
                </div>
                <button type="button" onClick={() => download(i)} disabled={!o.rows.length} aria-label={`Download ${o.label} order file`}
                  className="shrink-0 inline-flex items-center gap-1 px-sm py-1 rounded border border-primary/40 text-primary text-[11px] font-bold hover:bg-primary/10 disabled:opacity-40">
                  <Download className="w-3.5 h-3.5" /> CSV
                </button>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-sm">
            <span className="text-[10px] text-outline">The CSVs are for each supplier's upload; the workbook has everything in one file.</span>
            <button type="button" onClick={() => void downloadAll()} aria-label="Download everything as one workbook"
              className="inline-flex items-center gap-1 px-sm py-1 rounded-lg bg-primary text-white text-[11px] font-bold hover:brightness-110">
              <Download className="w-3.5 h-3.5" /> Download workbook (Excel)
            </button>
          </div>

          {quoted && (
            <div>
              <button type="button" onClick={() => setShowPrices((v) => !v)} className="text-[11px] font-bold text-primary hover:underline">
                {showPrices ? 'Hide prices' : `Show prices (${fmtNumber(quoted.length)} lines)`}
              </button>
              {showPrices && (
                <div className="mt-1 max-h-[420px] overflow-auto rounded-lg border border-outline-variant">
                  <table className="w-full text-[11px]" data-testid="price-table">
                    <thead className="sticky top-0 bg-surface-container-high text-outline uppercase text-[10px]">
                      <tr>
                        <th className="text-left px-2 py-1">Item</th>
                        <th className="text-right px-2 py-1">Qty</th>
                        {ORDER_SUPPLIERS.map(({ key: s, label }) => <th key={s} className="text-right px-2 py-1">{label}</th>)}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-outline-variant/30">
                      {quoted.map((q) => (
                        <tr key={q.stockCode}>
                          <td className="px-2 py-1 font-mono">{q.stockCode}</td>
                          <td className="px-2 py-1 text-right font-mono">{fmtNumber(q.qty)}</td>
                          {ORDER_SUPPLIERS.map(({ key: s, label }) => {
                            const p = q.quotes[s];
                            if (!p) return <td key={s} className="px-2 py-1 text-right text-outline/50">–</td>;
                            if (!isPriced(p)) return <td key={s} className="px-2 py-1 text-right text-outline" title={p.error}>no price</td>;
                            const chosen = assignment?.[q.stockCode] === s;
                            return (
                              <td key={s} className="px-1 py-0.5 text-right">
                                <button type="button" onClick={() => setPicks((prev) => ({ ...prev, [q.stockCode]: s }))}
                                  aria-label={`Buy ${q.stockCode} at ${label}`} aria-pressed={chosen}
                                  className={`w-full text-right rounded px-1 py-0.5 ${chosen ? 'bg-primary/15 ring-1 ring-primary text-on-surface font-bold' : 'hover:bg-surface-variant/40 text-on-surface-variant'}`}>
                                  <span className="font-mono">{fmtZAR(p.totalZar)}</span>
                                  <span className="block text-[9px] text-outline font-normal">
                                    {fmtCurrency(p.unit, p.currency, 4)} each{p.orderQty !== q.qty ? ` · buy ${fmtNumber(p.orderQty)}` : ''}{p.note ? ` · ${p.note}` : ''}
                                    {p.swappedFrom && <span className="block text-primary">{p.supplierPn}{p.packaging ? ` (${p.packaging})` : ''}, not {p.swappedFrom}</span>}
                                  </span>
                                  {!p.enoughStock && <span className="block text-[9px] text-amber-500 font-normal">{p.stock === 0 ? 'Out of stock' : `Only ${fmtNumber(p.stock ?? 0)} in stock`}</span>}
                                </button>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {nowhere.length > 0 && (
            <div className="text-[11px] text-amber-500">
              <button type="button" onClick={() => setShowMissing((v) => !v)} className="flex items-center gap-1 font-bold hover:underline">
                <AlertTriangle className="w-3.5 h-3.5" /> {fmtNumber(nowhere.length)} {nowhere.length === 1 ? 'line has' : 'lines have'} no Mouser, DigiKey or LCSC number
              </button>
              {showMissing && <p className="mt-1 font-mono text-on-surface-variant break-words">{nowhere.join(', ')}</p>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
