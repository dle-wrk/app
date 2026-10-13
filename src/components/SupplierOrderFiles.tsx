// BOM Audit > Order files: the project's BOM as one upload file per supplier
// (Mouser, DigiKey, LCSC), for the shortages or the whole build, using each
// item's supplier part numbers by slot. Formats: ../lib/supplierBom.

import React, { useMemo, useState } from 'react';
import { Download, ShoppingCart, AlertTriangle } from 'lucide-react';
import { fmtNumber } from '../lib/formatMoney';
import { atNoSupplier, downloadCsv, orderCsv, supplierOrders, type OrderLine } from '../lib/supplierBom';

export interface OrderFileLine extends Omit<OrderLine, 'qty'> {
  /** Needed for the whole build, and short of stock for it. */
  required: number;
  shortage: number;
}

const fileSafe = (s: string) => s.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'project';

export default function SupplierOrderFiles({ lines, projectName, pcbQty, onShowNotification }: {
  lines: OrderFileLine[];
  projectName: string;
  pcbQty: number;
  onShowNotification: (msg: string, type?: 'SUCCESS' | 'ERROR' | 'INFO') => void;
}) {
  const [basis, setBasis] = useState<'shortage' | 'build'>('shortage');
  const [showMissing, setShowMissing] = useState(false);
  const orders = useMemo(
    () => supplierOrders(lines.map((l) => ({ ...l, qty: basis === 'shortage' ? l.shortage : l.required }))),
    [lines, basis],
  );
  const nowhere = atNoSupplier(orders);
  const counted = lines.filter((l) => (basis === 'shortage' ? l.shortage : l.required) > 0).length;

  const download = (i: number) => {
    const o = orders[i];
    if (!o.rows.length) { onShowNotification(`No line has a ${o.label} part number.`, 'ERROR'); return; }
    const name = `${fileSafe(projectName)}_${o.supplier}_${basis === 'shortage' ? 'shortages' : 'build'}_${pcbQty}pcs.csv`;
    downloadCsv(name, orderCsv(o.supplier, o.rows));
    onShowNotification(`${o.label}: ${fmtNumber(o.rows.length)} lines written${o.missing.length ? `; ${fmtNumber(o.missing.length)} have no ${o.label} number` : ''}.`, 'SUCCESS');
  };

  return (
    <div className="bg-surface-container border border-outline-variant rounded-xl p-md space-y-sm" data-testid="order-files">
      <div className="flex flex-wrap items-center justify-between gap-sm">
        <div>
          <h4 className="text-sm font-bold text-on-surface flex items-center gap-2"><ShoppingCart className="w-4 h-4 text-primary" /> Order files</h4>
          <p className="text-[11px] text-on-surface-variant">One file per supplier, ready to upload on their website: Mouser's BOM tool, DigiKey's BOM manager, LCSC's BOM tool. Part numbers come from Sup PN 1 Mouser, 2 DigiKey, 3 LCSC.</p>
        </div>
        <div className="flex rounded-lg border border-outline-variant overflow-hidden text-[11px] font-bold" role="group" aria-label="Quantities">
          {([['shortage', 'Shortages only'], ['build', `Whole build (${fmtNumber(pcbQty)} pcs)`]] as const).map(([k, label]) => (
            <button key={k} type="button" onClick={() => setBasis(k)} aria-pressed={basis === k}
              className={`px-sm py-1 ${basis === k ? 'bg-primary text-white' : 'text-on-surface-variant hover:text-on-surface'}`}>{label}</button>
          ))}
        </div>
      </div>

      {counted === 0 ? (
        <p className="text-xs text-on-surface-variant">{basis === 'shortage' ? `Nothing is short for ${fmtNumber(pcbQty)} pcs: no order needed.` : 'This BOM has no lines to order.'}</p>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-sm">
            {orders.map((o, i) => (
              <div key={o.supplier} className="rounded-lg border border-outline-variant bg-surface-container-high/40 p-sm flex items-center justify-between gap-sm">
                <div className="min-w-0">
                  <div className="text-xs font-bold text-on-surface">{i + 1}. {o.label}</div>
                  <div className="text-[10px] text-outline">{fmtNumber(o.rows.length)} lines{o.missing.length ? ` · ${fmtNumber(o.missing.length)} not listed` : ''}</div>
                </div>
                <button type="button" onClick={() => download(i)} disabled={!o.rows.length} aria-label={`Download ${o.label} order file`}
                  className="shrink-0 inline-flex items-center gap-1 px-sm py-1 rounded border border-primary/40 text-primary text-[11px] font-bold hover:bg-primary/10 disabled:opacity-40">
                  <Download className="w-3.5 h-3.5" /> CSV
                </button>
              </div>
            ))}
          </div>
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
