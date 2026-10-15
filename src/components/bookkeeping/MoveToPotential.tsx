// "Move to Potential Order" on an invoice, sales order or quote: a short
// form inside the document's window (expected decision date, likelihood,
// reason) that says plainly what happens to the books, then moves it.
// Server: POST /api/potential-orders/from-invoice/:id | from-order/:id.

import React, { useState } from 'react';
import { Hourglass } from 'lucide-react';
import { apiPost, inputClass, selectClass, PrimaryButton, SecondaryButton } from './shared';
import { canChange } from '../../lib/changeAccess';
import { LIKELIHOODS } from '../../lib/potentialOrders';

export const MoveToPotential: React.FC<{
  source: 'invoice' | 'order';
  id: number;
  number: string;
  /** Invoice status, or the order's (QUOTATION for a quote). */
  status: string;
  onMoved: (potentialNumber: string) => void;
  onError: (msg: string) => void;
}> = ({ source, id, number, status, onMoved, onError }) => {
  const [open, setOpen] = useState(false);
  const [expectedDate, setExpectedDate] = useState('');
  const [likelihood, setLikelihood] = useState<string>('50');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  if (!canChange('/api/potential-orders', 'POST')) return null;

  const what = source === 'invoice'
    ? status === 'DRAFT'
      ? `Draft invoice ${number} hasn't been posted, so nothing in the books changes: it is voided and kept as a Potential Order.`
      : `${number} is taken out of the books: its journal entry (the amount owed, revenue and VAT) is reversed, any stock it took is returned, and the invoice is voided with a note. It leaves the overdue and outstanding lists. When the client confirms, it becomes a new invoice (or quote or sales order).`
    : status === 'QUOTATION'
      ? `Quotation ${number} is parked as a Potential Order. Confirming it brings the same quotation back (or makes it a sales order or invoice).`
      : `Sales order ${number} is parked as a Potential Order and its stock reservations are released. Confirming it brings the same order back (or makes it a quote or invoice).`;

  const move = async () => {
    setBusy(true);
    try {
      const body = { expectedDate: expectedDate || null, likelihoodPct: likelihood ? Number(likelihood) : null, reason: reason.trim() || null };
      const pot = await apiPost(`/api/potential-orders/${source === 'invoice' ? 'from-invoice' : 'from-order'}/${id}`, body);
      onMoved(pot.number);
    } catch (e: any) {
      onError(e?.message || 'Could not move it.');
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return <SecondaryButton type="button" icon={<Hourglass className="w-3.5 h-3.5" />} onClick={() => setOpen(true)}>Move to Potential Order</SecondaryButton>;
  }
  return (
    <div className="basis-full rounded-lg border border-primary/40 bg-primary/5 p-3 space-y-2 text-xs" data-testid="move-to-potential">
      <p className="text-on-surface-variant">{what}</p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <label className="space-y-1"><span className="text-[10px] uppercase text-outline font-bold">Expected decision</span>
          <input type="date" className={`${inputClass} py-1.5 text-xs`} value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} aria-label="Expected decision date" /></label>
        <label className="space-y-1"><span className="text-[10px] uppercase text-outline font-bold">Likelihood</span>
          <select className={`${selectClass} py-1.5 text-xs`} value={likelihood} onChange={(e) => setLikelihood(e.target.value)} aria-label="Likelihood">
            <option value="">Not sure</option>
            {LIKELIHOODS.map((l) => <option key={l} value={l}>{l}%</option>)}
          </select></label>
        <label className="space-y-1"><span className="text-[10px] uppercase text-outline font-bold">Reason</span>
          <input className={`${inputClass} py-1.5 text-xs`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Waiting on budget approval" aria-label="Reason" /></label>
      </div>
      <div className="flex justify-end gap-2">
        <SecondaryButton type="button" onClick={() => setOpen(false)} disabled={busy}>Cancel</SecondaryButton>
        <PrimaryButton type="button" onClick={() => void move()} disabled={busy}>{busy ? 'Moving…' : 'Move to Potential Orders'}</PrimaryButton>
      </div>
    </div>
  );
};
